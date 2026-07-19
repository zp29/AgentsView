import AppKit
import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var settings: AppSettings {
        didSet {
            guard settings != oldValue else { return }
            persistSettingsDebounced()
        }
    }
    @Published var tasks: [AgentTask] = []
    @Published var counts = StatusCounts()
    @Published var hubHealth: HubHealth = .starting
    @Published var toast: String = ""
    @Published var showOnboarding: Bool
    @Published private(set) var clock = Date()

    private let store: TaskStore
    private var hub: LocalHub?
    private var secret: String = ""
    private var toastTask: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?
    private var clockTimer: Timer?

    init() {
        let settings = AppSupport.loadSettings()
        self.settings = settings
        self.showOnboarding = !settings.hasCompletedOnboarding
        self.store = TaskStore(directory: AppSupport.root)
        // Never keep curl/dev seed sessions around as if they were real agents.
        _ = self.store.purgeSyntheticSessions()
        self.store.setOnChange { [weak self] in
            Task { @MainActor in self?.refreshFromStore() }
        }
        startRuntime()
        startClock()
    }

    
    // MARK: - Derived

    /// Menu bar shows only aggregate totals (no CC / GPT split).
    var statusLine: String {
        "\(counts.totalRunning)"
    }

    var compactStatusLine: String {
        "\(counts.totalRunning)"
    }

    var shouldShowBarCount: Bool {
        // Always show the number once live so empty "0" is honest, not demo noise.
        if case .live = hubHealth { return true }
        return counts.totalRunning > 0
    }

    var statusColor: Color {
        switch hubHealth {
        case .failed: return ABTheme.danger
        case .starting: return ABTheme.waiting
        case .live:
            if counts.totalWaiting > 0 { return ABTheme.waiting }
            if counts.totalRunning > 0 { return ABTheme.running }
            if counts.totalCompletedToday > 0 { return ABTheme.completed }
            return ABTheme.offline
        }
    }

    var connectionDetail: String {
        switch hubHealth {
        case .live:
            return "127.0.0.1:\(settings.hubPort)"
        case .starting:
            return "正在启动 Local Hub…"
        case .failed(let message):
            return message
        }
    }

    var runningTasks: [AgentTask] {
        tasks.filter { $0.status == .running }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var waitingTasks: [AgentTask] {
        tasks.filter { $0.status == .waitingApproval }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var completedTodayTasks: [AgentTask] {
        let calendar = Calendar.current
        return tasks.filter { task in
            guard task.status == .completed else { return false }
            if let completed = task.completedAt { return calendar.isDateInToday(completed) }
            return calendar.isDateInToday(task.updatedAt)
        }
        .sorted { $0.updatedAt > $1.updatedAt }
    }

    var isEmptyPanel: Bool {
        runningTasks.isEmpty
            && (!settings.showWaiting || waitingTasks.isEmpty)
            && (!settings.showCompleted || completedTodayTasks.isEmpty)
    }

    // MARK: - Actions

    func displayName(for task: AgentTask) -> String {
        NameFormatter.format(task: task, template: settings.nameTemplate)
    }

    func openTaskFolder(_ task: AgentTask) {
        guard !task.cwd.isEmpty else {
            flash("该任务没有工作目录")
            return
        }
        let url = URL(fileURLWithPath: task.cwd, isDirectory: true)
        guard FileManager.default.fileExists(atPath: url.path) else {
            flash("目录不存在：\(task.cwdBase)")
            return
        }
        NSWorkspace.shared.open(url)
    }

    func completeOnboarding(installClaude: Bool, installCodex: Bool, launchAtLogin: Bool) {
        var next = settings
        next.installClaudeHooks = installClaude
        next.installCodexHooks = installCodex
        next.launchAtLogin = launchAtLogin
        next.hasCompletedOnboarding = true
        settings = next
        // didSet saves; also force launch item now
        AppSupport.setLaunchAtLogin(launchAtLogin)

        var providers: [AgentKind] = []
        if installClaude { providers.append(.claude) }
        if installCodex { providers.append(.codex) }
        do {
            try AppSupport.installRelayScript()
            if !providers.isEmpty {
                try HookInstaller.install(providers: providers, relayPath: AppSupport.hookRelayURL.path)
                flash("已就绪。请新开 Claude Code / Codex 会话。")
            } else {
                flash("已跳过 Hook，可在设置中随时安装。")
            }
        } catch {
            flash("Hook 安装失败：\(error.localizedDescription)")
        }
        showOnboarding = false
    }

    func reinstallHooks() {
        var providers: [AgentKind] = []
        if settings.installClaudeHooks { providers.append(.claude) }
        if settings.installCodexHooks { providers.append(.codex) }
        if providers.isEmpty { providers = AgentKind.allCases }
        do {
            try AppSupport.installRelayScript()
            try HookInstaller.install(providers: providers, relayPath: AppSupport.hookRelayURL.path)
            flash("Hooks 已重新安装")
        } catch {
            flash("重装失败：\(error.localizedDescription)")
        }
    }

    func removeHooks() {
        do {
            try HookInstaller.uninstall()
            flash("已移除 AgentsBar Hooks")
        } catch {
            flash("移除失败：\(error.localizedDescription)")
        }
    }

    func openSupportFolder() {
        NSWorkspace.shared.open(AppSupport.root)
    }

    func clearCompletedToday() {
        let ids = Set(completedTodayTasks.map(\.id))
        guard !ids.isEmpty else {
            flash("今日没有已完成任务")
            return
        }
        store.removeTasks(ids: ids)
        refreshFromStore()
        flash("已清除今日完成记录")
    }

    func clearAllTasks() {
        store.clearAll()
        refreshFromStore()
        flash("已清空全部任务（仅本地观察记录）")
    }

    func flash(_ message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            if !Task.isCancelled, toast == message {
                toast = ""
            }
        }
    }

    // MARK: - Runtime

    private func startRuntime() {
        hubHealth = .starting
        do {
            secret = try AppSupport.ensureLayout(port: settings.hubPort)
            let hub = LocalHub(port: UInt16(settings.hubPort), secret: secret, store: store)
            try hub.start { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.hubHealth = .live
                        self.refreshFromStore()
                    case .failure(let error):
                        self.hubHealth = .failed(error.localizedDescription)
                        self.flash("Hub 启动失败：\(error.localizedDescription)")
                    }
                }
            }
            self.hub = hub
            refreshFromStore()

            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if case .starting = self.hubHealth {
                    self.hubHealth = .failed("Hub 未在 2.5 秒内就绪")
                    self.flash("Hub 启动超时")
                }
            }
        } catch {
            hubHealth = .failed(error.localizedDescription)
            flash("Hub 启动失败：\(error.localizedDescription)")
        }
    }

    private func refreshFromStore() {
        tasks = store.snapshot()
        counts = store.counts(now: clock)
    }

    private func startClock() {
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.clock = Date()
                self?.refreshFromStore()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        clockTimer = timer
    }

    private func persistSettingsDebounced() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            AppSupport.saveSettings(settings)
            AppSupport.setLaunchAtLogin(settings.launchAtLogin)
        }
    }
}

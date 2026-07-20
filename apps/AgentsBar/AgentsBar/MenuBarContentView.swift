import AppKit
import SwiftUI

/// Primary product surface — window-style menu bar panel (not a system menu).
struct MenuBarContentView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    @State private var appear = false

    var body: some View {
        ZStack {
            panelBackground
            VStack(spacing: 0) {
                header
                metrics
                Divider().overlay(ABTheme.line).padding(.horizontal, 14)
                taskList
                footer
            }
        }
        .frame(width: ABTheme.panelWidth, height: ABTheme.panelHeight)
        .preferredColorScheme(.dark)
        .opacity(appear ? 1 : 0)
        .offset(y: appear ? 0 : 6)
        .onAppear {
            withAnimation(.easeOut(duration: 0.22)) { appear = true }
            if model.showOnboarding {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    openWindow(id: "onboarding")
                    NSApp.activate(ignoringOtherApps: true)
                }
            }
        }
    }

    // MARK: - Sections

    private var panelBackground: some View {
        ZStack {
            ABTheme.bg
            // soft top glow
            RadialGradient(
                colors: [model.statusColor.opacity(0.10), .clear],
                center: .topLeading,
                startRadius: 10,
                endRadius: 220
            )
            // fine grain via repeated lines (cheap texture)
            VStack(spacing: 3) {
                ForEach(0..<80, id: \.self) { _ in
                    Rectangle()
                        .fill(Color.white.opacity(0.012))
                        .frame(height: 1)
                }
            }
            .mask(
                LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .bottom)
            )
        }
        .clipShape(RoundedRectangle(cornerRadius: 0))
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Image("AppLogo")
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 22, height: 22)
                        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    Text("AgentsBar")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(ABTheme.text)
                    connectionPill
                }
                Text(model.connectionDetail)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(ABTheme.textDim)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !model.toast.isEmpty {
                Text(model.toast)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ABTheme.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(ABTheme.bgSoft)
                    .clipShape(Capsule())
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .animation(.easeOut(duration: 0.2), value: model.toast)
    }

    private var connectionPill: some View {
        HStack(spacing: 5) {
            StatusDot(color: model.hubHealth.accent, pulse: model.hubHealth.isLive && model.counts.totalRunning > 0)
            Text(model.hubHealth.label)
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(model.hubHealth.accent)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(model.hubHealth.accent.opacity(0.10))
        .overlay(
            Capsule().strokeBorder(model.hubHealth.accent.opacity(0.22), lineWidth: 1)
        )
        .clipShape(Capsule())
    }

    private var metrics: some View {
        HStack(spacing: 8) {
            MetricChip(label: "运行中", value: model.counts.totalRunning, color: ABTheme.running)
            MetricChip(label: "今日完成", value: model.counts.totalCompletedToday, color: ABTheme.completed)
            if model.settings.showWaiting || model.counts.totalWaiting > 0 {
                MetricChip(label: "待处理", value: model.counts.totalWaiting, color: ABTheme.waiting)
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }

    private var taskList: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 14) {
                if model.isEmptyPanel {
                    emptyState
                        .padding(.top, 28)
                        .padding(.bottom, 12)
                } else {
                    if model.settings.showWaiting, !model.waitingTasks.isEmpty {
                        section(title: "待处理", count: model.waitingTasks.count, accent: ABTheme.waiting) {
                            ForEach(model.waitingTasks.prefix(8)) { task in
                                TaskRow(task: task, now: model.clock) {
                                    model.openTaskFolder(task)
                                }
                            }
                        }
                    }

                    if model.settings.showRunning, !model.runningTasks.isEmpty {
                        section(title: "运行中", count: model.runningTasks.count, accent: ABTheme.running) {
                            ForEach(model.runningTasks.prefix(12)) { task in
                                TaskRow(task: task, now: model.clock) {
                                    model.openTaskFolder(task)
                                }
                            }
                        }
                    }

                    if model.settings.showCompleted, !model.completedTodayTasks.isEmpty {
                        section(title: "今日完成", count: model.completedTodayTasks.count, accent: ABTheme.completed) {
                            ForEach(model.completedTodayTasks.prefix(12)) { task in
                                TaskRow(task: task, now: model.clock) {
                                    model.openTaskFolder(task)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .animation(.easeOut(duration: 0.18), value: model.counts.totalRunning)
            .animation(.easeOut(duration: 0.18), value: model.counts.totalCompletedToday)
        }
        .frame(maxHeight: .infinity)
    }

    private func section<Content: View>(title: String, count: Int, accent: Color, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(0.8)
                    .foregroundStyle(ABTheme.textMuted)
                    .textCase(.uppercase)
                Text("\(count)")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(accent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(accent.opacity(0.12))
                    .clipShape(Capsule())
                Spacer()
            }
            content()
        }
    }

    private func emptyRow(text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(ABTheme.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(ABTheme.bgElevated.opacity(0.55))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(ABTheme.running.opacity(0.8))
            Text("等待真实会话")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.text)
            Text("新开一个 Claude Code 或 Codex 会话后，任务会出现在这里。")
                .font(.system(size: 11))
                .foregroundStyle(ABTheme.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 240)
            Button {
                model.reinstallHooks()
            } label: {
                Text("检查 Hooks 安装")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(ABTheme.running)
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider().overlay(ABTheme.line)
            HStack(spacing: 8) {
                footerButton("设置", systemImage: "slider.horizontal.3") {
                    openSettings()
                    NSApp.activate(ignoringOtherApps: true)
                }
                footerButton("Hooks", systemImage: "link") {
                    model.reinstallHooks()
                }
                footerButton("数据", systemImage: "folder") {
                    model.openSupportFolder()
                }
                Spacer()
                footerButton("退出", systemImage: "power") {
                    NSApplication.shared.terminate(nil)
                }
                .foregroundStyle(ABTheme.textDim)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(ABTheme.bgElevated.opacity(0.55))
    }

    private func footerButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(ABTheme.textMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

// MARK: - Task row

private struct TaskRow: View {
    @EnvironmentObject private var model: AppModel
    let task: AgentTask
    let now: Date
    let onOpen: () -> Void

    @State private var hovering = false

    private var stale: Bool {
        model.isStale(task)
    }

    private var borderColor: Color {
        if stale { return ABTheme.stale.opacity(hovering ? 0.95 : 0.80) }
        return hovering ? ABTheme.lineStrong : ABTheme.line
    }

    private var borderWidth: CGFloat { stale ? 1.5 : 1 }

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 10) {
                // left accent rail (orange when idle ≥ 45m)
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(stale ? ABTheme.stale : task.status.accent)
                    .frame(width: 3, height: 34)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        AgentBadge(agent: task.agent, compact: true)
                        Text(NameFormatter.truncate(model.displayName(for: task), limit: 30))
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(ABTheme.text)
                            .lineLimit(1)
                        if stale {
                            Text("久未活动")
                                .font(.system(size: 9, weight: .bold, design: .rounded))
                                .foregroundStyle(ABTheme.stale)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(ABTheme.stale.opacity(0.14))
                                .overlay(
                                    Capsule().strokeBorder(ABTheme.stale.opacity(0.45), lineWidth: 1)
                                )
                                .clipShape(Capsule())
                        }
                        Spacer(minLength: 4)
                        Text(NameFormatter.relativeTime(task.updatedAt, now: now))
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundStyle(stale ? ABTheme.stale.opacity(0.9) : ABTheme.textDim)
                    }

                    HStack(spacing: 6) {
                        if !task.cwdBase.isEmpty {
                            Label(task.cwdBase, systemImage: "folder")
                                .labelStyle(.titleAndIcon)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(ABTheme.textMuted)
                                .lineLimit(1)
                        }
                        if let outcome = NameFormatter.outcomeLabel(task.outcome) {
                            Text("·")
                                .foregroundStyle(ABTheme.textDim)
                            Text(outcome)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(task.status.accent.opacity(0.9))
                        }
                        Spacer()
                        if hovering, !task.cwd.isEmpty {
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(ABTheme.textDim)
                        }
                    }

                    if !task.summary.isEmpty {
                        Text(NameFormatter.truncate(task.summary, limit: 72))
                            .font(.system(size: 10.5))
                            .foregroundStyle(ABTheme.textDim)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(
                stale
                    ? ABTheme.stale.opacity(hovering ? 0.10 : 0.06)
                    : (hovering ? ABTheme.bgSoft : ABTheme.bgElevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: borderWidth)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu { statusMenu }
        .onHover { value in
            withAnimation(.easeOut(duration: 0.12)) { hovering = value }
            if value { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
        .help(rowHelp)
    }

    @ViewBuilder
    private var statusMenu: some View {
        if task.status == .running || task.status == .waitingApproval {
            Button("标记为完成") { model.markCompleted(task, outcome: "success") }
            Button("标记为中断") { model.markCompleted(task, outcome: "interrupted") }
            Divider()
        }
        if task.status == .completed {
            Button("重新标记为运行中") { model.markRunning(task) }
            Divider()
        }
        if !task.cwd.isEmpty {
            Button("打开项目目录") { onOpen() }
        }
        Button("从列表移除", role: .destructive) { model.removeTask(task) }
    }

    private var rowHelp: String {
        if stale {
            return "超过 45 分钟无活动 — 右键可手动标记状态"
        }
        if task.status == .running || task.status == .waitingApproval {
            return "右键可标记完成 / 中断；点击打开目录"
        }
        return task.cwd.isEmpty ? model.displayName(for: task) : "在 Finder 中打开 \(task.cwd)"
    }
}

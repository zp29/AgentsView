import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var templateDraft: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                previewCard
                sectionCard(title: "状态栏与列表") {
                    toggleRow("显示运行中", $model.settings.showRunning)
                    toggleRow("显示今日已完成", $model.settings.showCompleted)
                    toggleRow("显示待审批分组", $model.settings.showWaiting)
                }
                sectionCard(title: "任务名称") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("模板")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(ABTheme.textDim)
                        TextField("{agent}-{cwd}-{title}", text: $templateDraft)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12, design: .monospaced))
                            .padding(10)
                            .background(ABTheme.bg)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .strokeBorder(ABTheme.line, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .onChange(of: templateDraft) { _, value in
                                model.settings.nameTemplate = value.isEmpty ? "{agent}-{cwd}-{title}" : value
                            }
                        Text("{agent}  {cwd}  {title}  {status}  {outcome}")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(ABTheme.textDim)
                        if let sample = model.runningTasks.first ?? model.completedTodayTasks.first {
                            HStack {
                                Text("预览")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(ABTheme.textDim)
                                Spacer()
                                Text(model.displayName(for: sample))
                                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                                    .foregroundStyle(ABTheme.text)
                                    .lineLimit(1)
                            }
                            .padding(.top, 2)
                        }
                    }
                }
                sectionCard(title: "Hooks") {
                    toggleRow("管理 Claude Code", $model.settings.installClaudeHooks)
                    toggleRow("管理 Codex", $model.settings.installCodexHooks)
                    HStack(spacing: 8) {
                        actionButton("重新安装", systemImage: "arrow.clockwise") {
                            model.reinstallHooks()
                        }
                        actionButton("移除 Hooks", systemImage: "trash", danger: true) {
                            model.removeHooks()
                        }
                    }
                    .padding(.top, 4)
                }
                sectionCard(title: "通用") {
                    toggleRow("登录时启动", $model.settings.launchAtLogin)
                    infoRow("Hub", "127.0.0.1:\(model.settings.hubPort)")
                    HStack {
                        infoRow("数据", "Application Support/AgentsBar")
                        Spacer()
                        actionButton("打开", systemImage: "folder") {
                            model.openSupportFolder()
                        }
                    }
                    HStack(spacing: 8) {
                        if model.counts.totalCompletedToday > 0 {
                            actionButton("清除今日完成", systemImage: "eraser") {
                                model.clearCompletedToday()
                            }
                        }
                        if !model.tasks.isEmpty {
                            actionButton("清空全部任务", systemImage: "trash", danger: true) {
                                model.clearAllTasks()
                            }
                        }
                    }
                    .padding(.top, 2)
                }
                if !model.toast.isEmpty {
                    Text(model.toast)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ABTheme.running)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(20)
        }
        .frame(minWidth: 440, minHeight: 520)
        .background(ABTheme.bg)
        .preferredColorScheme(.dark)
        .onAppear { templateDraft = model.settings.nameTemplate }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("设置")
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.text)
            Text("更改会自动保存")
                .font(.system(size: 12))
                .foregroundStyle(ABTheme.textMuted)
        }
    }

    private var previewCard: some View {
        HStack(spacing: 14) {
            Image("AppLogo")
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: 28, height: 28)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text("菜单栏预览")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ABTheme.textDim)
                Text("运行中 \(model.counts.totalRunning)")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(ABTheme.text)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(model.hubHealth.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(model.hubHealth.accent)
                Text(model.connectionDetail)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(ABTheme.textDim)
                    .lineLimit(1)
            }
        }
        .padding(14)
        .background(ABTheme.bgElevated)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(ABTheme.line, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func sectionCard<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(1)
                .foregroundStyle(ABTheme.textDim)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ABTheme.bgElevated)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(ABTheme.line, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func toggleRow(_ title: String, _ binding: Binding<Bool>) -> some View {
        Toggle(isOn: binding) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ABTheme.text)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
    }

    private func infoRow(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ABTheme.textDim)
            Text(v)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(ABTheme.textMuted)
                .lineLimit(1)
        }
    }

    private func actionButton(_ title: String, systemImage: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(danger ? ABTheme.danger : ABTheme.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(danger ? ABTheme.danger.opacity(0.12) : ABTheme.bgSoft)
            .overlay(
                Capsule().strokeBorder(danger ? ABTheme.danger.opacity(0.3) : ABTheme.line, lineWidth: 1)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

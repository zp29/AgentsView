import AppKit
import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var installClaude = true
    @State private var installCodex = true
    @State private var launchAtLogin = true
    @State private var step: Int = 0
    @State private var busy = false

    var body: some View {
        ZStack {
            ABTheme.bg.ignoresSafeArea()
            RadialGradient(
                colors: [ABTheme.running.opacity(0.12), .clear],
                center: .topTrailing,
                startRadius: 20,
                endRadius: 320
            )
            .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                header
                content
                Spacer(minLength: 12)
                actions
            }
            .padding(28)
        }
        .frame(width: 460, height: 460)
        .preferredColorScheme(.dark)
        .onAppear {
            installClaude = model.settings.installClaudeHooks
            installCodex = model.settings.installCodexHooks
            launchAtLogin = model.settings.launchAtLogin
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(ABTheme.running.opacity(0.15))
                        .frame(width: 40, height: 40)
                    Image(systemName: "circle.grid.cross.fill")
                        .foregroundStyle(ABTheme.running)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("AgentsBar")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .foregroundStyle(ABTheme.text)
                    Text("本机菜单栏 · 真实 CC / GPT 会话观察")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ABTheme.textMuted)
                }
            }
            progress
                .padding(.top, 10)
        }
        .padding(.bottom, 18)
    }

    private var progress: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { index in
                Capsule()
                    .fill(index <= step ? ABTheme.running : ABTheme.lineStrong)
                    .frame(width: index == step ? 28 : 14, height: 4)
                    .animation(.easeOut(duration: 0.2), value: step)
            }
            Spacer()
            Text(["欢迎", "连接", "完成"][step])
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.textDim)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case 0:
            welcomeStep
        case 1:
            connectStep
        default:
            doneStep
        }
    }

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("打开就能用")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.text)
            Text("AgentsBar 内置 Local Hub，无需 npm 或 AgentsView 服务。首次只需安装 Hooks，之后新开会话即可在菜单栏看到状态。")
                .font(.system(size: 13))
                .foregroundStyle(ABTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 10) {
                featureRow("statusline", "状态栏显示 CC / GPT 运行数")
                featureRow("eye", "只观察，不拦截终端权限")
                featureRow("lock.shield", "仅监听 127.0.0.1，数据留在本机")
            }
            .padding(.top, 6)
        }
    }

    private var connectStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("连接真实代理")
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.text)
            Text("将轻量 command hook 写入配置。失败时 CLI 不受影响。")
                .font(.system(size: 12))
                .foregroundStyle(ABTheme.textMuted)

            toggleCard(
                title: "Claude Code",
                subtitle: "~/.claude/settings.json",
                badge: "CC",
                color: ABTheme.cc,
                isOn: $installClaude
            )
            toggleCard(
                title: "Codex",
                subtitle: "~/.codex/hooks.json",
                badge: "GPT",
                color: ABTheme.gpt,
                isOn: $installCodex
            )
            toggleCard(
                title: "登录时启动",
                subtitle: "开机后自动出现在菜单栏",
                badge: "···",
                color: ABTheme.running,
                isOn: $launchAtLogin
            )
        }
    }

    private var doneStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("就差一步")
                .font(.system(size: 22, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.text)
            Text("点击完成后，请新开 Claude Code 或 Codex 会话。已打开的旧会话不会上报。")
                .font(.system(size: 13))
                .foregroundStyle(ABTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            QuietCard {
                VStack(alignment: .leading, spacing: 8) {
                    labelValue("状态栏", "CC n  ·  GPT m")
                    labelValue("主面板", "点击菜单栏图标打开")
                    labelValue("权限", "仍在终端原生处理")
                }
            }
        }
    }

    private var actions: some View {
        HStack {
            if step > 0 {
                Button("上一步") {
                    withAnimation(.easeOut(duration: 0.15)) { step -= 1 }
                }
                .buttonStyle(QuietButtonStyle(prominent: false))
            } else {
                Button("稍后再说") {
                    model.completeOnboarding(installClaude: false, installCodex: false, launchAtLogin: launchAtLogin)
                    dismiss()
                }
                .buttonStyle(QuietButtonStyle(prominent: false))
            }
            Spacer()
            Button(primaryTitle) {
                if step < 2 {
                    withAnimation(.easeOut(duration: 0.15)) { step += 1 }
                } else {
                    busy = true
                    model.completeOnboarding(
                        installClaude: installClaude,
                        installCodex: installCodex,
                        launchAtLogin: launchAtLogin
                    )
                    busy = false
                    dismiss()
                }
            }
            .buttonStyle(QuietButtonStyle(prominent: true))
            .disabled(busy)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.top, 12)
    }

    private var primaryTitle: String {
        switch step {
        case 0: return "继续"
        case 1: return "下一步"
        default: return "完成并启用"
        }
    }

    private func featureRow(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ABTheme.running)
                .frame(width: 28, height: 28)
                .background(ABTheme.running.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(text)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(ABTheme.text)
        }
    }

    private func toggleCard(title: String, subtitle: String, badge: String, color: Color, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 12) {
            Text(badge)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .frame(width: 36, height: 28)
                .background(color.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ABTheme.text)
                Text(subtitle)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ABTheme.textDim)
            }
            Spacer()
            Toggle("", isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
        .padding(12)
        .background(ABTheme.bgElevated)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(ABTheme.line, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func labelValue(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ABTheme.textDim)
            Spacer()
            Text(v)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(ABTheme.text)
        }
    }
}

struct QuietButtonStyle: ButtonStyle {
    var prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .semibold, design: .rounded))
            .foregroundStyle(prominent ? Color.black.opacity(0.88) : ABTheme.textMuted)
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .background(
                prominent
                    ? AnyShapeStyle(ABTheme.running.opacity(configuration.isPressed ? 0.75 : 1))
                    : AnyShapeStyle(ABTheme.bgSoft.opacity(configuration.isPressed ? 0.7 : 1))
            )
            .overlay(
                Capsule().strokeBorder(prominent ? Color.clear : ABTheme.line, lineWidth: 1)
            )
            .clipShape(Capsule())
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

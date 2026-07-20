import SwiftUI

/// Quiet Console — deep charcoal, sparse type, single accent for state.
enum ABTheme {
    static let bg = Color(red: 0.043, green: 0.055, blue: 0.078)          // #0B0E14
    static let bgElevated = Color(red: 0.071, green: 0.090, blue: 0.133)  // #121722
    static let bgSoft = Color(red: 0.094, green: 0.118, blue: 0.173)      // #181E2C
    static let line = Color.white.opacity(0.08)
    static let lineStrong = Color.white.opacity(0.14)
    static let text = Color(red: 0.91, green: 0.93, blue: 0.96)
    static let textMuted = Color(red: 0.55, green: 0.60, blue: 0.68)
    static let textDim = Color(red: 0.40, green: 0.45, blue: 0.52)

    static let running = Color(red: 0.37, green: 0.92, blue: 0.83)        // mint cyan
    static let waiting = Color(red: 0.96, green: 0.73, blue: 0.26)        // amber
    static let completed = Color(red: 0.49, green: 0.85, blue: 0.62)      // sage
    static let danger = Color(red: 1.0, green: 0.42, blue: 0.45)
    static let offline = Color(red: 0.55, green: 0.58, blue: 0.64)

    /// Menu-bar icon ring colors (user-facing: green / red-orange / red flash).
    static let ringRunning = Color(red: 0.22, green: 0.90, blue: 0.48)   // green
    static let ringWaiting = Color(red: 1.0, green: 0.42, blue: 0.18)    // red-orange
    static let ringCompleted = Color(red: 1.0, green: 0.28, blue: 0.32)  // red

    /// List-row highlight when a running task has been idle ≥ 45 minutes.
    static let stale = Color(red: 1.0, green: 0.55, blue: 0.18)          // warm orange

    static let cc = Color(red: 0.72, green: 0.68, blue: 0.98)             // soft lilac
    static let gpt = Color(red: 0.45, green: 0.82, blue: 0.95)            // ice blue

    static let radius: CGFloat = 14
    static let radiusSm: CGFloat = 10
    static let panelWidth: CGFloat = 360
    static let panelHeight: CGFloat = 520
}

extension AgentKind {
    var badgeColor: Color {
        switch self {
        case .claude: return ABTheme.cc
        case .codex: return ABTheme.gpt
        }
    }
}

extension TaskStatus {
    var accent: Color {
        switch self {
        case .running: return ABTheme.running
        case .waitingApproval: return ABTheme.waiting
        case .completed: return ABTheme.completed
        }
    }

    var symbol: String {
        switch self {
        case .running: return "waveform"
        case .waitingApproval: return "hand.raised.fill"
        case .completed: return "checkmark"
        }
    }
}

extension HubHealth {
    var accent: Color {
        switch self {
        case .live: return ABTheme.running
        case .starting: return ABTheme.waiting
        case .failed: return ABTheme.danger
        }
    }

    var label: String {
        switch self {
        case .live: return "在线"
        case .starting: return "启动中"
        case .failed: return "离线"
        }
    }
}

struct AgentBadge: View {
    let agent: AgentKind
    var compact: Bool = false

    var body: some View {
        Text(agent.shortName)
            .font(.system(size: compact ? 9 : 10, weight: .bold, design: .rounded))
            .tracking(0.6)
            .foregroundStyle(agent.badgeColor)
            .padding(.horizontal, compact ? 5 : 7)
            .padding(.vertical, compact ? 2 : 3)
            .background(agent.badgeColor.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(agent.badgeColor.opacity(0.28), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

struct StatusDot: View {
    let color: Color
    var pulse: Bool = false

    var body: some View {
        ZStack {
            if pulse {
                Circle()
                    .fill(color.opacity(0.28))
                    .frame(width: 12, height: 12)
            }
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .shadow(color: color.opacity(0.55), radius: 4, y: 0)
        }
        .frame(width: 12, height: 12)
    }
}

struct QuietCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(12)
            .background(ABTheme.bgElevated)
            .overlay(
                RoundedRectangle(cornerRadius: ABTheme.radiusSm, style: .continuous)
                    .strokeBorder(ABTheme.line, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: ABTheme.radiusSm, style: .continuous))
    }
}

struct MetricChip: View {
    let label: String
    let value: Int
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .tracking(1.1)
                .foregroundStyle(ABTheme.textDim)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(value)")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(value > 0 ? color : ABTheme.textMuted)
                Circle()
                    .fill(value > 0 ? color : ABTheme.lineStrong)
                    .frame(width: 6, height: 6)
                    .padding(.bottom, 3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ABTheme.bgSoft.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(ABTheme.line, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

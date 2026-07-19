import Foundation

enum AgentKind: String, Codable, CaseIterable, Identifiable {
    case claude
    case codex

    var id: String { rawValue }

    var shortName: String {
        switch self {
        case .claude: return "CC"
        case .codex: return "GPT"
        }
    }

    var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        }
    }
}

enum TaskStatus: String, Codable, CaseIterable {
    case running
    case waitingApproval = "waiting_approval"
    case completed
}

struct AgentTask: Identifiable, Codable, Hashable {
    var id: String
    var agent: AgentKind
    var status: TaskStatus
    var title: String
    var cwd: String
    var summary: String
    var externalId: String
    var startedAt: Date
    var updatedAt: Date
    var completedAt: Date?
    var outcome: String?

    var cwdBase: String {
        URL(fileURLWithPath: cwd).lastPathComponent
    }
}

struct AppSettings: Codable, Equatable {
    var showRunning: Bool = true
    var showCompleted: Bool = true
    var showWaiting: Bool = false
    var nameTemplate: String = "{agent}-{cwd}-{title}"
    var launchAtLogin: Bool = true
    var hubPort: Int = 18273
    var installClaudeHooks: Bool = true
    var installCodexHooks: Bool = true
    var hasCompletedOnboarding: Bool = false
}

enum HubHealth: Equatable {
    case starting
    case live
    case failed(String)

    var isLive: Bool {
        if case .live = self { return true }
        return false
    }
}

struct StatusCounts: Equatable {
    var claudeRunning: Int = 0
    var claudeCompletedToday: Int = 0
    var claudeWaiting: Int = 0
    var codexRunning: Int = 0
    var codexCompletedToday: Int = 0
    var codexWaiting: Int = 0

    var totalRunning: Int { claudeRunning + codexRunning }
    var totalWaiting: Int { claudeWaiting + codexWaiting }
    var totalCompletedToday: Int { claudeCompletedToday + codexCompletedToday }
}

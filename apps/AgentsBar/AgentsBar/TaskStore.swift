import Foundation

/// Authoritative in-memory task store with JSON snapshot persistence.
final class TaskStore: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.agentsview.bar.store")
    private var tasks: [String: AgentTask] = [:]
    private let fileURL: URL
    private var onChange: (() -> Void)?

    init(directory: URL) {
        self.fileURL = directory.appendingPathComponent("state.json")
        load()
    }

    func setOnChange(_ handler: @escaping () -> Void) {
        queue.async { self.onChange = handler }
    }

    func snapshot() -> [AgentTask] {
        queue.sync { Array(tasks.values) }
    }

    func counts(now: Date = Date()) -> StatusCounts {
        let calendar = Calendar.current
        let items = snapshot()
        var result = StatusCounts()
        for task in items {
            switch (task.agent, task.status) {
            case (.claude, .running): result.claudeRunning += 1
            case (.claude, .waitingApproval): result.claudeWaiting += 1
            case (.claude, .completed):
                if let completed = task.completedAt, calendar.isDateInToday(completed) {
                    result.claudeCompletedToday += 1
                } else if task.completedAt == nil, calendar.isDateInToday(task.updatedAt) {
                    result.claudeCompletedToday += 1
                }
            case (.codex, .running): result.codexRunning += 1
            case (.codex, .waitingApproval): result.codexWaiting += 1
            case (.codex, .completed):
                if let completed = task.completedAt, calendar.isDateInToday(completed) {
                    result.codexCompletedToday += 1
                } else if task.completedAt == nil, calendar.isDateInToday(task.updatedAt) {
                    result.codexCompletedToday += 1
                }
            }
        }
        return result
    }

    /// Idle threshold used only for UI highlighting — never auto-completes.
    static let staleHighlightInterval: TimeInterval = 45 * 60

    /// Whether an open task has had no hook activity for `interval` (default 45 minutes).
    func isStale(_ task: AgentTask, now: Date = Date(), interval: TimeInterval = TaskStore.staleHighlightInterval) -> Bool {
        guard task.status == .running || task.status == .waitingApproval else { return false }
        return now.timeIntervalSince(task.updatedAt) >= interval
    }

    /// User-driven status change (observation UI only — does not affect the real agent).
    func setStatus(id: String, status: TaskStatus, outcome: String? = nil, summary: String? = nil) {
        queue.sync {
            guard var task = tasks[id] else { return }
            let now = Date()
            task.status = status
            task.updatedAt = now
            if status == .completed {
                task.completedAt = now
                task.outcome = outcome ?? task.outcome ?? "success"
                if let summary, !summary.isEmpty {
                    task.summary = String(summary.prefix(400))
                }
            } else {
                task.completedAt = nil
                if status == .running {
                    task.outcome = nil
                }
            }
            tasks[id] = task
            persistLocked()
            notifyLocked()
        }
    }

    func removeTasks(ids: Set<String>) {
        queue.sync {
            for id in ids { tasks.removeValue(forKey: id) }
            persistLocked()
            notifyLocked()
        }
    }

    /// Drop every stored task (used to purge injected/test state).
    func clearAll() {
        queue.sync {
            tasks.removeAll()
            persistLocked()
            notifyLocked()
        }
    }

    /// Remove synthetic sessions used during development (never real CLI ids).
    @discardableResult
    func purgeSyntheticSessions() -> Int {
        queue.sync {
            let before = tasks.count
            let syntheticPrefixes = ["test-", "ui-", "demo", "codex-test", "seed-"]
            let removable = tasks.values.filter { task in
                let external = task.externalId.lowercased()
                let id = task.id.lowercased()
                return syntheticPrefixes.contains { external.hasPrefix($0) || id.contains($0) }
                    || external.hasPrefix("test-session")
                    || external.hasPrefix("ui-cc")
                    || external.hasPrefix("ui-gpt")
            }
            for task in removable {
                tasks.removeValue(forKey: task.id)
            }
            if !removable.isEmpty {
                persistLocked()
                notifyLocked()
            }
            return before - tasks.count
        }
    }

    @discardableResult
    func handleHook(provider: AgentKind, payload: [String: Any]) throws -> [String: Any] {
        try queue.sync {
            let event = string(payload["hook_event_name"]) ?? string(payload["event"]) ?? ""
            let sessionId = string(payload["session_id"])
                ?? string(payload["sessionId"])
                ?? string(payload["conversation_id"])
                ?? ""
            guard !event.isEmpty, !sessionId.isEmpty else {
                throw HubError.badRequest("hook_event_name and session_id are required")
            }

            // Observation only: never intercept terminal permissions.
            if event == "PermissionRequest" {
                return [:]
            }

            let task = ensureTask(provider: provider, sessionId: sessionId, payload: payload)
            let now = Date()

            switch event {
            case "SessionStart":
                update(task.id) {
                    if $0.status == .completed {
                        // New logical task if a completed session restarts — handled by ensureTask.
                    } else {
                        $0.status = .running
                        $0.updatedAt = now
                        $0.summary = "\(provider.displayName) session started."
                    }
                }
            case "UserPromptSubmit":
                let prompt = string(payload["prompt"]) ?? ""
                update(task.id) {
                    $0.status = .running
                    $0.updatedAt = now
                    if !prompt.isEmpty {
                        $0.summary = String(prompt.prefix(200))
                        if $0.title.contains("·") || $0.title.hasPrefix(provider.displayName) {
                            $0.title = Self.shortTitle(from: prompt, fallback: $0.title)
                        }
                    } else {
                        $0.summary = "\(provider.displayName) is processing a prompt."
                    }
                }
            case "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop":
                let tool = string(payload["tool_name"]) ?? string(payload["agent_type"]) ?? event
                let detail = Self.toolDetail(payload)
                update(task.id) {
                    if $0.status != .completed { $0.status = .running }
                    $0.updatedAt = now
                    $0.summary = "\(tool): \(detail)"
                }
            case "Stop":
                let message = string(payload["last_assistant_message"]) ?? "\(provider.displayName) finished."
                // Close every open task for this session (guards against duplicate running rows).
                completeOpenTasks(provider: provider, sessionId: sessionId, outcome: "success", summary: message, at: now)
            case "StopFailure":
                let message = string(payload["error"]) ?? "\(provider.displayName) failed."
                completeOpenTasks(provider: provider, sessionId: sessionId, outcome: "failed", summary: message, at: now)
            case "SessionEnd":
                completeOpenTasks(
                    provider: provider,
                    sessionId: sessionId,
                    outcome: "interrupted",
                    summary: "\(provider.displayName) session ended.",
                    at: now
                )
            default:
                update(task.id) {
                    if $0.status != .completed { $0.status = .running }
                    $0.updatedAt = now
                    $0.summary = event
                }
            }

            persistLocked()
            notifyLocked()
            return [:]
        }
    }

    private func completeOpenTasks(
        provider: AgentKind,
        sessionId: String,
        outcome: String,
        summary: String,
        at: Date
    ) {
        let open = tasks.values.filter {
            $0.agent == provider && $0.externalId == sessionId && $0.status != .completed
        }
        if open.isEmpty {
            // Ensure we still record completion against the latest task row if needed.
            if let latest = tasks.values
                .filter({ $0.agent == provider && $0.externalId == sessionId })
                .sorted(by: { $0.updatedAt > $1.updatedAt })
                .first,
               latest.status != .completed {
                complete(latest.id, outcome: outcome, summary: summary, at: at)
            }
            return
        }
        for task in open {
            complete(task.id, outcome: outcome, summary: summary, at: at)
        }
    }

    private func ensureTask(provider: AgentKind, sessionId: String, payload: [String: Any]) -> AgentTask {
        let event = string(payload["hook_event_name"]) ?? string(payload["event"]) ?? ""

        // A new user prompt after a completed turn should open a fresh task row.
        // Reuse only the latest non-completed task for this session.
        if let existing = tasks.values
            .filter({ $0.agent == provider && $0.externalId == sessionId && $0.status != .completed })
            .sorted(by: { $0.updatedAt > $1.updatedAt })
            .first {
            return existing
        }

        // SessionEnd / Stop on an already-completed session: attach to latest row.
        if event == "SessionEnd" || event == "Stop" || event == "StopFailure",
           let latest = tasks.values
            .filter({ $0.agent == provider && $0.externalId == sessionId })
            .sorted(by: { $0.updatedAt > $1.updatedAt })
            .first {
            return latest
        }

        let cwd = string(payload["cwd"]) ?? string(payload["workspace_roots"]).flatMap { firstPath(in: $0) } ?? ""
        let project = URL(fileURLWithPath: cwd.isEmpty ? "/" : cwd).lastPathComponent
        let title = string(payload["session_title"])
            ?? (project.isEmpty ? "\(provider.displayName) session" : "\(provider.displayName) · \(project)")
        let now = Date()
        let id = "\(provider.rawValue)-\(stableHash(sessionId))-\(String(UUID().uuidString.prefix(8)).lowercased())"
        let task = AgentTask(
            id: id,
            agent: provider,
            status: .running,
            title: String(title.prefix(160)),
            cwd: String(cwd.prefix(1000)),
            summary: "\(provider.displayName) session connected.",
            externalId: sessionId,
            startedAt: now,
            updatedAt: now,
            completedAt: nil,
            outcome: nil
        )
        tasks[id] = task
        return task
    }

    private func update(_ id: String, mutate: (inout AgentTask) -> Void) {
        guard var task = tasks[id] else { return }
        mutate(&task)
        tasks[id] = task
    }

    private func complete(_ id: String, outcome: String, summary: String, at: Date) {
        update(id) {
            $0.status = .completed
            $0.outcome = outcome
            $0.summary = String(summary.prefix(400))
            $0.updatedAt = at
            $0.completedAt = at
        }
        pruneLocked()
    }

    private func pruneLocked() {
        let maxTasks = 240
        guard tasks.count > maxTasks else { return }
        let removable = tasks.values
            .filter { $0.status == .completed }
            .sorted { $0.updatedAt < $1.updatedAt }
        let overflow = tasks.count - maxTasks
        for task in removable.prefix(overflow) {
            tasks.removeValue(forKey: task.id)
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let decoded = try? decoder.decode([AgentTask].self, from: data) {
            for task in decoded {
                tasks[task.id] = task
            }
        }
    }

    private func persistLocked() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let list = Array(tasks.values).sorted { $0.updatedAt > $1.updatedAt }
        guard let data = try? encoder.encode(list) else { return }
        try? data.write(to: fileURL, options: [.atomic])
    }

    private func notifyLocked() {
        let handler = onChange
        DispatchQueue.main.async { handler?() }
    }

    private func string(_ value: Any?) -> String? {
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n.stringValue }
        return nil
    }

    private func firstPath(in raw: String) -> String? {
        if raw.hasPrefix("["), let data = raw.data(using: .utf8),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
            return arr.first
        }
        return raw
    }

    private static func shortTitle(from prompt: String, fallback: String) -> String {
        let line = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? prompt
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return fallback }
        return String(trimmed.prefix(80))
    }

    private static func toolDetail(_ payload: [String: Any]) -> String {
        if let input = payload["tool_input"] as? [String: Any] {
            if let command = input["command"] as? String { return String(command.prefix(160)) }
            if let path = input["file_path"] as? String ?? input["path"] as? String {
                return URL(fileURLWithPath: path).lastPathComponent
            }
            if let data = try? JSONSerialization.data(withJSONObject: input),
               let text = String(data: data, encoding: .utf8) {
                return String(text.prefix(160))
            }
        }
        return ""
    }

    private func stableHash(_ value: String) -> String {
        var hash: UInt64 = 5381
        for byte in value.utf8 {
            hash = 127 &* hash &+ UInt64(byte)
        }
        return String(hash, radix: 16)
    }
}

enum HubError: LocalizedError {
    case badRequest(String)
    case unauthorized
    case notFound

    var errorDescription: String? {
        switch self {
        case .badRequest(let message): return message
        case .unauthorized: return "Unauthorized"
        case .notFound: return "Not found"
        }
    }

    var statusCode: Int {
        switch self {
        case .badRequest: return 400
        case .unauthorized: return 401
        case .notFound: return 404
        }
    }
}

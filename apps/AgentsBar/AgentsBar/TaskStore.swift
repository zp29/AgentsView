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
            // Normalize Claude + Codex field aliases into one shape.
            let event = Self.eventName(from: payload)
            let sessionId = Self.sessionId(from: payload)
            guard !event.isEmpty, !sessionId.isEmpty else {
                Self.debugLog(
                    provider: provider,
                    reason: "missing event/session",
                    event: event,
                    sessionId: sessionId,
                    payload: payload
                )
                throw HubError.badRequest("hook_event_name and session_id are required")
            }

            // Observation only: never intercept terminal permissions.
            if event == "PermissionRequest" {
                return [:]
            }

            // Model switch / resume / compact often emit SessionStart without real user work.
            // Do not open a new task row for these — only refresh an already-open task.
            if event == "SessionStart" {
                let now = Date()
                if let open = openTask(provider: provider, sessionId: sessionId) {
                    update(open.id) {
                        $0.status = .running
                        $0.updatedAt = now
                        // Keep existing title/summary; just note the session is alive.
                        if $0.summary.isEmpty {
                            $0.summary = "\(provider.displayName) session active."
                        }
                    }
                    persistLocked()
                    notifyLocked()
                }
                return [:]
            }

            // Slash commands like `/model …` are not real tasks.
            if event == "UserPromptSubmit" {
                let prompt = Self.promptText(from: payload)
                if Self.isIgnorablePrompt(prompt) {
                    return [:]
                }
            }

            // Stop / SessionEnd without an open task: no-op (do not create rows just to close them).
            if event == "Stop" || event == "StopFailure" || event == "SessionEnd" {
                let now = Date()
                let open = tasks.values.filter {
                    $0.agent == provider && $0.externalId == sessionId && $0.status != .completed
                }
                if open.isEmpty { return [:] }
                switch event {
                case "Stop":
                    let message = string(payload["last_assistant_message"]) ?? "\(provider.displayName) finished."
                    completeOpenTasks(provider: provider, sessionId: sessionId, outcome: "success", summary: message, at: now)
                case "StopFailure":
                    let message = string(payload["error"]) ?? "\(provider.displayName) failed."
                    completeOpenTasks(provider: provider, sessionId: sessionId, outcome: "failed", summary: message, at: now)
                default:
                    completeOpenTasks(
                        provider: provider,
                        sessionId: sessionId,
                        outcome: "interrupted",
                        summary: "\(provider.displayName) session ended.",
                        at: now
                    )
                }
                persistLocked()
                notifyLocked()
                return [:]
            }

            // Real work signals: user prompt or tool activity — create/reuse a task.
            let createIfMissing = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop"].contains(event)
            guard let task = ensureTask(
                provider: provider,
                sessionId: sessionId,
                payload: payload,
                createIfMissing: createIfMissing
            ) else {
                return [:]
            }
            let now = Date()

            switch event {
            case "UserPromptSubmit":
                let prompt = Self.promptText(from: payload)
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
                let tool = string(payload["tool_name"])
                    ?? string(payload["agent_type"])
                    ?? string(payload["tool"])
                    ?? event
                let detail = Self.toolDetail(payload)
                update(task.id) {
                    if $0.status != .completed { $0.status = .running }
                    $0.updatedAt = now
                    $0.summary = detail.isEmpty ? tool : "\(tool): \(detail)"
                }
            default:
                // Unknown lifecycle noise (e.g. future hook names) — do not invent tasks.
                return [:]
            }

            persistLocked()
            notifyLocked()
            return [:]
        }
    }

    /// Slash commands / control prompts that should not become observed tasks.
    private static func isIgnorablePrompt(_ prompt: String) -> Bool {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }

        let lower = trimmed.lowercased()
        // Claude Code / Codex control commands (model switch, config, etc.)
        let controlPrefixes = [
            "/model", "/models",
            "/config", "/settings",
            "/help", "/status",
            "/clear", "/compact", "/cost",
            "/login", "/logout",
            "/doctor", "/memory",
            "/permissions", "/vim",
            "/theme", "/bug",
            "/exit", "/quit",
        ]
        if controlPrefixes.contains(where: { lower == $0 || lower.hasPrefix($0 + " ") || lower.hasPrefix($0 + "\n") }) {
            return true
        }

        // Some UIs inject XML-ish system wrappers without real user text.
        if lower.hasPrefix("<command-name>") || lower.hasPrefix("<command-message>") {
            return true
        }
        if lower.contains("set model to") && trimmed.count < 80 {
            return true
        }
        return false
    }

    private func openTask(provider: AgentKind, sessionId: String) -> AgentTask? {
        tasks.values
            .filter { $0.agent == provider && $0.externalId == sessionId && $0.status != .completed }
            .sorted { $0.updatedAt > $1.updatedAt }
            .first
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

    /// Returns an open task for the session, or creates one when `createIfMissing` is true.
    private func ensureTask(
        provider: AgentKind,
        sessionId: String,
        payload: [String: Any],
        createIfMissing: Bool
    ) -> AgentTask? {
        // Reuse only the latest non-completed task for this session.
        if let existing = openTask(provider: provider, sessionId: sessionId) {
            return existing
        }

        guard createIfMissing else { return nil }

        let cwd = Self.cwd(from: payload)
        let project = URL(fileURLWithPath: cwd.isEmpty ? "/" : cwd).lastPathComponent
        let prompt = Self.promptText(from: payload)
        let titleFromPrompt = prompt.isEmpty ? nil : Self.shortTitle(from: prompt, fallback: "")
        let title = string(payload["session_title"])
            ?? string(payload["title"])
            ?? (titleFromPrompt.flatMap { $0.isEmpty ? nil : $0 })
            ?? (project.isEmpty ? "\(provider.displayName) session" : "\(provider.displayName) · \(project)")
        let now = Date()
        let id = "\(provider.rawValue)-\(stableHash(sessionId))-\(String(UUID().uuidString.prefix(8)).lowercased())"
        let task = AgentTask(
            id: id,
            agent: provider,
            status: .running,
            title: String(title.prefix(160)),
            cwd: String(cwd.prefix(1000)),
            summary: prompt.isEmpty
                ? "\(provider.displayName) is working."
                : String(prompt.prefix(200)),
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
        Self.stringValue(value)
    }

    private static func stringValue(_ value: Any?) -> String? {
        if let s = value as? String {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        if let n = value as? NSNumber { return n.stringValue }
        return nil
    }

    private static func eventName(from payload: [String: Any]) -> String {
        stringValue(payload["hook_event_name"])
            ?? stringValue(payload["hookEventName"])
            ?? stringValue(payload["event"])
            ?? stringValue(payload["event_name"])
            ?? stringValue(payload["type"])
            ?? ""
    }

    private static func sessionId(from payload: [String: Any]) -> String {
        stringValue(payload["session_id"])
            ?? stringValue(payload["sessionId"])
            ?? stringValue(payload["conversation_id"])
            ?? stringValue(payload["conversationId"])
            ?? stringValue(payload["thread_id"])
            ?? stringValue(payload["threadId"])
            // Last resort: turn-scoped only events can still group by turn when session is absent.
            ?? stringValue(payload["turn_id"])
            ?? stringValue(payload["turnId"])
            ?? ""
    }

    private static func promptText(from payload: [String: Any]) -> String {
        if let prompt = stringValue(payload["prompt"]) { return prompt }
        if let message = stringValue(payload["message"]) { return message }
        if let text = stringValue(payload["text"]) { return text }
        if let content = stringValue(payload["content"]) { return content }
        if let arr = payload["content"] as? [Any] {
            let joined = arr.compactMap { item -> String? in
                if let s = item as? String { return s }
                if let obj = item as? [String: Any] {
                    return stringValue(obj["text"]) ?? stringValue(obj["content"])
                }
                return nil
            }.joined(separator: "\n")
            if !joined.isEmpty { return joined }
        }
        return ""
    }

    private static func cwd(from payload: [String: Any]) -> String {
        if let cwd = stringValue(payload["cwd"]) { return cwd }
        if let roots = payload["workspace_roots"] as? [String], let first = roots.first, !first.isEmpty {
            return first
        }
        if let roots = stringValue(payload["workspace_roots"]) {
            return firstPath(in: roots) ?? roots
        }
        if let dir = stringValue(payload["working_directory"]) { return dir }
        return ""
    }

    private static func firstPath(in raw: String) -> String? {
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
        let input = (payload["tool_input"] as? [String: Any])
            ?? (payload["input"] as? [String: Any])
            ?? (payload["arguments"] as? [String: Any])
        if let input {
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

    /// Append a short debug line when Codex/Claude payloads are dropped or malformed.
    private static func debugLog(
        provider: AgentKind,
        reason: String,
        event: String,
        sessionId: String,
        payload: [String: Any]
    ) {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AgentsBar", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("hook-debug.jsonl")
        let keys = Array(payload.keys).sorted().joined(separator: ",")
        let line = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "provider": provider.rawValue,
            "reason": reason,
            "event": event,
            "session": sessionId,
            "keys": keys,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: line),
              var text = String(data: data, encoding: .utf8) else { return }
        text += "\n"
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            if let bytes = text.data(using: .utf8) {
                try? handle.write(contentsOf: bytes)
            }
        } else {
            try? text.data(using: .utf8)?.write(to: file, options: .atomic)
        }
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

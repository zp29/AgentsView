import Foundation

enum HookInstaller {
    private static let claudeEvents = [
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "PermissionRequest", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "SessionEnd",
    ]
    private static let codexEvents = [
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
        "PermissionRequest", "SubagentStart", "SubagentStop", "Stop",
    ]

    static var claudeSettingsURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/settings.json")
    }

    static var codexHooksURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/hooks.json")
    }

    static func install(providers: [AgentKind], relayPath: String, timeoutSeconds: Int = 25) throws {
        for provider in providers {
            switch provider {
            case .claude:
                try install(into: claudeSettingsURL, provider: provider, events: claudeEvents, relayPath: relayPath, timeout: timeoutSeconds)
            case .codex:
                try install(into: codexHooksURL, provider: provider, events: codexEvents, relayPath: relayPath, timeout: timeoutSeconds)
            }
        }
    }

    static func uninstall(providers: [AgentKind] = AgentKind.allCases) throws {
        let relay = AppSupport.hookRelayURL.path
        for provider in providers {
            let url = provider == .claude ? claudeSettingsURL : codexHooksURL
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            var root = try readObject(url)
            guard var hooks = root["hooks"] as? [String: Any] else { continue }
            for key in hooks.keys {
                if let groups = hooks[key] as? [[String: Any]] {
                    let cleaned = removeAgentsBar(groups: groups, relayPath: relay, provider: provider)
                    if cleaned.isEmpty {
                        hooks.removeValue(forKey: key)
                    } else {
                        hooks[key] = cleaned
                    }
                }
            }
            root["hooks"] = hooks
            try atomicWrite(root, to: url)
        }
    }

    private static func install(
        into url: URL,
        provider: AgentKind,
        events: [String],
        relayPath: String,
        timeout: Int
    ) throws {
        var root = (try? readObject(url)) ?? [:]
        var hooks = (root["hooks"] as? [String: Any]) ?? [:]
        // Invoke via /bin/bash so paths with spaces (Application Support) are reliable.
        // Codex runs command hooks with a shell; bare quoted paths can fail depending on executor.
        let command = "/bin/bash \(shellQuote(relayPath)) \(provider.rawValue)"
        // Codex matchers are regex; "*" / "" both mean "all". Prefer "*" for Codex docs examples.
        let matcher = provider == .codex ? "*" : ""

        for event in events {
            var groups = (hooks[event] as? [[String: Any]]) ?? []
            groups = removeAgentsBar(groups: groups, relayPath: relayPath, provider: provider)
            groups.append([
                "matcher": matcher,
                "hooks": [[
                    "type": "command",
                    "command": command,
                    "timeout": timeout,
                ]],
            ])
            hooks[event] = groups
        }

        // Scrub any leftover AgentsBar hooks on events we no longer use.
        for key in hooks.keys where !events.contains(key) {
            if let groups = hooks[key] as? [[String: Any]] {
                let cleaned = removeAgentsBar(groups: groups, relayPath: relayPath, provider: provider)
                if cleaned.isEmpty {
                    hooks.removeValue(forKey: key)
                } else {
                    hooks[key] = cleaned
                }
            }
        }

        root["hooks"] = hooks
        try atomicWrite(root, to: url)
    }

    private static func removeAgentsBar(groups: [[String: Any]], relayPath: String, provider: AgentKind) -> [[String: Any]] {
        groups.compactMap { group -> [String: Any]? in
            var next = group
            let hooks = (group["hooks"] as? [[String: Any]]) ?? []
            let filtered = hooks.filter { hook in
                let command = String(describing: hook["command"] ?? "")
                let isOurs = command.contains("agentsbar-hook")
                    || command.contains(relayPath)
                    || command.contains("AgentsBar/bin")
                if !isOurs { return true }
                // Keep only if it's clearly for the other provider (shouldn't happen).
                return !command.contains(provider.rawValue) && command.contains(provider == .claude ? "codex" : "claude")
            }
            if filtered.isEmpty { return nil }
            next["hooks"] = filtered
            return next
        }
    }

    private static func readObject(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        let object = try JSONSerialization.jsonObject(with: data)
        guard let dict = object as? [String: Any] else {
            throw HubError.badRequest("Invalid JSON object at \(url.path)")
        }
        return dict
    }

    private static func atomicWrite(_ object: [String: Any], to url: URL) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: url.path) {
            let stamp = ISO8601DateFormatter().string(from: Date())
                .replacingOccurrences(of: ":", with: "-")
            let backup = url.appendingPathExtension("agentsbar-backup-\(stamp)")
            try? FileManager.default.copyItem(at: url, to: backup)
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        let temporary = url.appendingPathExtension("tmp-\(ProcessInfo.processInfo.processIdentifier)")
        try data.write(to: temporary, options: [.atomic])
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        try FileManager.default.moveItem(at: temporary, to: url)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

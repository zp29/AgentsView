import Foundation
import Security
import ServiceManagement

enum AppSupport {
    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("AgentsBar", isDirectory: true)
    }

    static var binDirectory: URL { root.appendingPathComponent("bin", isDirectory: true) }
    static var hookRelayURL: URL { binDirectory.appendingPathComponent("agentsbar-hook") }
    static var secretURL: URL { root.appendingPathComponent("hook-secret") }
    static var portURL: URL { root.appendingPathComponent("hub-port") }
    static var settingsURL: URL { root.appendingPathComponent("settings.json") }
    static var stateURL: URL { root.appendingPathComponent("state.json") }

    @discardableResult
    static func ensureLayout(port: Int) throws -> String {
        try FileManager.default.createDirectory(at: binDirectory, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)

        let secret = try loadOrCreateSecret()
        try "\(port)\n".write(to: portURL, atomically: true, encoding: .utf8)
        try installRelayScript()
        return secret
    }

    static func loadOrCreateSecret() throws -> String {
        if let existing = try? String(contentsOf: secretURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return existing
        }
        let generated = randomSecret()
        try generated.write(to: secretURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: secretURL.path)
        return generated
    }

    static func installRelayScript() throws {
        let sourceCandidates = [
            Bundle.main.url(forResource: "agentsbar-hook", withExtension: nil),
            Bundle.main.resourceURL?.appendingPathComponent("agentsbar-hook"),
            // Dev: repo path when running from Xcode without resource copy
            URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .appendingPathComponent("Resources/agentsbar-hook"),
        ].compactMap { $0 }

        guard let source = sourceCandidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            // Fallback: embed minimal script body
            try Self.embeddedRelay.write(to: hookRelayURL, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookRelayURL.path)
            return
        }
        if FileManager.default.fileExists(atPath: hookRelayURL.path) {
            try FileManager.default.removeItem(at: hookRelayURL)
        }
        try FileManager.default.copyItem(at: source, to: hookRelayURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookRelayURL.path)
    }

    static func loadSettings() -> AppSettings {
        guard let data = try? Data(contentsOf: settingsURL) else { return AppSettings() }
        return (try? JSONDecoder().decode(AppSettings.self, from: data)) ?? AppSettings()
    }

    static func saveSettings(_ settings: AppSettings) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(settings) else { return }
        try? data.write(to: settingsURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsURL.path)
    }

    static func setLaunchAtLogin(_ enabled: Bool) {
        if #available(macOS 13.0, *) {
            do {
                if enabled {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                NSLog("[AgentsBar] launch at login: \(error.localizedDescription)")
            }
        }
    }

    private static func randomSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static let embeddedRelay = """
    #!/usr/bin/env bash
    set -euo pipefail
    PROVIDER="${1:-}"
    if [[ "$PROVIDER" != "claude" && "$PROVIDER" != "codex" ]]; then echo '{}'; exit 0; fi
    SUPPORT="${HOME}/Library/Application Support/AgentsBar"
    SECRET_FILE="${SUPPORT}/hook-secret"
    PORT_FILE="${SUPPORT}/hub-port"
    PORT=18273
    [[ -f "$PORT_FILE" ]] && PORT="$(tr -d '[:space:]' < "$PORT_FILE" || true)"
    [[ -n "$PORT" ]] || PORT=18273
    if [[ ! -f "$SECRET_FILE" ]]; then echo '{}'; exit 0; fi
    SECRET="$(tr -d '[:space:]' < "$SECRET_FILE")"
    BODY="$(cat || true)"
    [[ -z "${BODY//[[:space:]]/}" ]] && BODY='{}'
    URL="http://127.0.0.1:${PORT}/hooks/${PROVIDER}"
    RESPONSE="$(/usr/bin/curl -sS -m 3 -X POST "$URL" -H "Content-Type: application/json" -H "X-AgentsBar-Hook-Secret: ${SECRET}" --data-binary "$BODY" 2>/dev/null || true)"
    if [[ -z "${RESPONSE//[[:space:]]/}" ]]; then echo '{}'; else printf '%s' "$RESPONSE"; fi
    exit 0
    """
}

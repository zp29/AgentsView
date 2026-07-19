import Foundation

enum NameFormatter {
    static func format(task: AgentTask, template: String) -> String {
        let map: [String: String] = [
            "{agent}": task.agent.shortName,
            "{title}": task.title,
            "{cwd}": task.cwdBase.isEmpty ? "—" : task.cwdBase,
            "{status}": statusLabel(task.status),
            "{outcome}": task.outcome ?? "",
        ]
        var result = template
        for (key, value) in map {
            result = result.replacingOccurrences(of: key, with: value)
        }
        return result
            .replacingOccurrences(of: "--", with: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: "- "))
    }

    static func statusLabel(_ status: TaskStatus) -> String {
        switch status {
        case .running: return "运行中"
        case .waitingApproval: return "待审批"
        case .completed: return "已完成"
        }
    }

    static func truncate(_ text: String, limit: Int) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        let end = trimmed.index(trimmed.startIndex, offsetBy: max(0, limit - 1))
        return String(trimmed[..<end]) + "…"
    }

    static func relativeTime(_ date: Date, now: Date = Date()) -> String {
        let seconds = Int(now.timeIntervalSince(date))
        if seconds < 15 { return "刚刚" }
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        return "\(days)d"
    }

    static func outcomeLabel(_ outcome: String?) -> String? {
        guard let outcome, !outcome.isEmpty else { return nil }
        switch outcome {
        case "success": return "成功"
        case "failed": return "失败"
        case "interrupted": return "中断"
        default: return outcome
        }
    }
}

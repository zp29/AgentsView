import AppKit
import SwiftUI

@main
struct AgentsBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContentView()
                .environmentObject(model)
        } label: {
            // MenuBarExtra ignores some SwiftUI layout; feed a pre-sized NSImage
            // so the status item stays ~18pt and doesn't crowd the bar.
            Label {
                if model.shouldShowBarCount {
                    Text(model.compactStatusLine)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                }
            } icon: {
                Image(nsImage: StatusItemIcon.image)
            }
            .labelStyle(.titleAndIcon)
            .help(barHelp)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(model)
        }

        Window("欢迎使用 AgentsBar", id: "onboarding") {
            OnboardingView()
                .environmentObject(model)
        }
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
    }

    private var barHelp: String {
        switch model.hubHealth {
        case .failed(let message):
            return "AgentsBar 离线：\(message)"
        case .starting:
            return "AgentsBar 正在启动…"
        case .live:
            return "运行中 \(model.counts.totalRunning) · 今日完成 \(model.counts.totalCompletedToday)"
        }
    }
}

/// Fixed-size status-item artwork. Avoids MenuBarExtra treating a large PNG as hundreds of points.
enum StatusItemIcon {
    /// Point size for menu bar (macOS status items are typically 16–18pt).
    static let pointSize: CGFloat = 18

    static let image: NSImage = {
        let size = NSSize(width: pointSize, height: pointSize)
        let target = NSImage(size: size)

        guard let source = NSImage(named: "MenuBarLogo") ?? loadFallback() else {
            // Last resort: empty template square so the item still appears.
            let empty = NSImage(size: size)
            empty.isTemplate = true
            return empty
        }

        target.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        source.draw(
            in: NSRect(origin: .zero, size: size),
            from: NSRect(origin: .zero, size: source.size),
            operation: .sourceOver,
            fraction: 1.0,
            respectFlipped: false,
            hints: [.interpolation: NSImageInterpolation.high]
        )
        target.unlockFocus()
        target.isTemplate = false
        // Critical: tell AppKit the image is 18×18 points, not the bitmap's pixel size.
        target.size = size
        return target
    }()

    private static func loadFallback() -> NSImage? {
        if let url = Bundle.main.url(forResource: "MenuBarLogo", withExtension: "png") {
            return NSImage(contentsOf: url)
        }
        return nil
    }
}

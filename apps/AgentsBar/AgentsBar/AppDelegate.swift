import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var openOnboardingObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // When onboarding window is requested, bring app forward so the window is visible
        // for an LSUIElement / accessory app.
        openOnboardingObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { note in
            guard let window = note.object as? NSWindow else { return }
            if window.title.contains("AgentsBar") || window.identifier?.rawValue == "onboarding" {
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

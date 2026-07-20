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
            StatusItemLabel(model: model)
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
}

// MARK: - Status item

/// Menu bar chip. Uses a timer (not TimelineView) — MenuBarExtra often drops TimelineView labels.
private struct StatusItemLabel: View {
    @ObservedObject var model: AppModel
    @State private var dashPhase: CGFloat = 0
    @State private var blinkOn = true
    @State private var spinTimer: Timer?
    @State private var blinkTask: Task<Void, Never>?

    private var shouldSpin: Bool {
        switch model.statusRing {
        case .running, .waiting: return true
        default: return false
        }
    }

    private var helpText: String {
        switch model.hubHealth {
        case .failed(let message):
            return "AgentsBar 离线：\(message)"
        case .starting:
            return "AgentsBar 正在启动…"
        case .live:
            return "运行中 \(model.counts.totalRunning) · 今日完成 \(model.counts.totalCompletedToday)"
        }
    }

    var body: some View {
        let image = StatusItemBadge.image(
            ring: displayRing,
            countText: model.shouldShowBarCount ? model.compactStatusLine : nil,
            dashPhase: dashPhase
        )

        // Always show something: baked badge, or SF Symbol fallback if image is empty.
        Group {
            if image.size.width > 0, image.size.height > 0 {
                Image(nsImage: image)
                    .renderingMode(.original)
            } else {
                Label("AgentsBar", systemImage: "circle.hexagongrid.circle.fill")
                    .labelStyle(.iconOnly)
            }
        }
        .help(helpText)
        .onAppear {
            syncSpinTimer()
            startBlinkIfNeeded(model.statusRing)
        }
        .onDisappear {
            spinTimer?.invalidate()
            spinTimer = nil
            blinkTask?.cancel()
        }
        .onChange(of: model.statusRing) { _, ring in
            syncSpinTimer()
            startBlinkIfNeeded(ring)
        }
        .onChange(of: model.counts.totalRunning) { _, _ in
            syncSpinTimer()
        }
    }

    private var displayRing: AppModel.StatusRing {
        if model.statusRing == .completedFlash, !blinkOn {
            return .none
        }
        return model.statusRing
    }

    private func syncSpinTimer() {
        if shouldSpin {
            if spinTimer == nil {
                // ~10 fps; small phase step keeps the chase calm (about one lap / ~3s).
                let timer = Timer(timeInterval: 1.0 / 10.0, repeats: true) { _ in
                    Task { @MainActor in
                        dashPhase += 0.9
                    }
                }
                RunLoop.main.add(timer, forMode: .common)
                spinTimer = timer
            }
        } else {
            spinTimer?.invalidate()
            spinTimer = nil
            dashPhase = 0
        }
    }

    private func startBlinkIfNeeded(_ ring: AppModel.StatusRing) {
        blinkTask?.cancel()
        blinkOn = true
        guard ring == .completedFlash else { return }
        blinkTask = Task { @MainActor in
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 280_000_000)
                if Task.isCancelled || model.statusRing != .completedFlash { break }
                blinkOn.toggle()
            }
            blinkOn = true
        }
    }
}

// MARK: - Badge renderer

/// Renders `[logo] N` optionally inside a capsule. Active rings use a chasing dashed stroke.
enum StatusItemBadge {
    static let logoPoint: CGFloat = 14
    static let iconTextGap: CGFloat = 7
    static let contentInsetX: CGFloat = 6
    static let contentInsetY: CGFloat = 3
    static let borderWidth: CGFloat = 1.6
    static let outerPad: CGFloat = 1
    static let cornerRadius: CGFloat = 6
    static let minHeight: CGFloat = 18

    private static let logo: NSImage = {
        makeLogoImage()
    }()

    static func image(
        ring: AppModel.StatusRing,
        countText: String?,
        dashPhase: CGFloat = 0
    ) -> NSImage {
        let text = countText ?? ""
        let showText = !text.isEmpty
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        let textAttrs: [NSAttributedString.Key: Any] = [
            .font: font,
            // Always white so the count stays readable on dark menu bars and inside tinted chips.
            .foregroundColor: NSColor.white,
        ]
        // Use glyph bounds / cap-height for vertical optical centering — NSString.size height
        // includes asymmetric leading that makes digits look high relative to the logo.
        let textWidth: CGFloat
        let textHeight: CGFloat
        if showText {
            let raw = (text as NSString).size(withAttributes: textAttrs)
            textWidth = ceil(raw.width)
            textHeight = ceil(font.capHeight)
        } else {
            textWidth = 0
            textHeight = 0
        }

        let contentWidth = logoPoint + (showText ? iconTextGap + textWidth : 0)
        let contentHeight = max(logoPoint, textHeight, minHeight - contentInsetY * 2)

        let framed = ring != .none
        let padX = framed ? contentInsetX : 1
        let padY = framed ? contentInsetY : 1
        let border = framed ? borderWidth : 0
        let outer = framed ? outerPad : 0

        let width = max(logoPoint + 2, outer * 2 + border * 2 + padX * 2 + contentWidth)
        let height = max(minHeight, outer * 2 + border * 2 + padY * 2 + contentHeight)

        // Retina-safe bitmap (lockFocus alone can produce blank images in menu bar refresh paths).
        let scale = max(NSScreen.main?.backingScaleFactor ?? 2, 2)
        let pixelW = max(1, Int(ceil(width * scale)))
        let pixelH = max(1, Int(ceil(height * scale)))

        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixelW,
            pixelsHigh: pixelH,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return fallbackSymbolImage()
        }
        rep.size = NSSize(width: width, height: height)

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
            return fallbackSymbolImage()
        }
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        ctx.shouldAntialias = true

        // Clear
        NSColor.clear.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()

        let contentX = outer + border + padX
        let contentY = (height - contentHeight) / 2

        if framed, let color = ringNSColor(ring) {
            let rect = NSRect(
                x: outer + border / 2,
                y: outer + border / 2,
                width: width - outer * 2 - border,
                height: height - outer * 2 - border
            )
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)
            path.lineWidth = border
            path.lineCapStyle = .round
            path.lineJoinStyle = .round

            color.withAlphaComponent(0.12).setFill()
            path.fill()

            switch ring {
            case .running, .waiting:
                color.withAlphaComponent(0.30).setStroke()
                path.stroke()

                let dashes: [CGFloat] = [5.5, 4.0]
                let period: CGFloat = 9.5
                var phase = dashPhase.truncatingRemainder(dividingBy: period)
                if phase < 0 { phase += period }
                path.setLineDash(dashes, count: dashes.count, phase: phase)
                color.setStroke()
                path.stroke()
                path.setLineDash(nil, count: 0, phase: 0)

            case .completedFlash:
                color.setStroke()
                path.stroke()

            case .none:
                break
            }
        }

        // Center logo and digits on the same horizontal midline of the chip.
        let midY = contentY + contentHeight / 2

        let logoRect = NSRect(
            x: contentX,
            y: midY - logoPoint / 2,
            width: logoPoint,
            height: logoPoint
        )
        logo.draw(in: logoRect, from: .zero, operation: .sourceOver, fraction: 1.0)

        if showText {
            // Baseline so the cap-height box is centered on midY (optical align with logo).
            // descender is negative; add a tiny nudge so rounded digits sit with the orbit mark.
            // let baseline = midY - font.capHeight / 2 - font.descender - 0.5
            let baseline = midY - logoPoint / 2
            let textOrigin = NSPoint(
                x: contentX + logoPoint + iconTextGap,
                y: baseline
            )
            (text as NSString).draw(at: textOrigin, withAttributes: textAttrs)
        }

        let image = NSImage(size: NSSize(width: width, height: height))
        image.addRepresentation(rep)
        image.isTemplate = false
        return image
    }

    private static func makeLogoImage() -> NSImage {
        let size = NSSize(width: logoPoint, height: logoPoint)
        let scale = max(NSScreen.main?.backingScaleFactor ?? 2, 2)
        let px = max(1, Int(ceil(logoPoint * scale)))

        if let source = NSImage(named: "MenuBarLogo") ?? loadFallback(),
           let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: px,
            pixelsHigh: px,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
           ) {
            rep.size = size
            NSGraphicsContext.saveGraphicsState()
            if let ctx = NSGraphicsContext(bitmapImageRep: rep) {
                NSGraphicsContext.current = ctx
                ctx.imageInterpolation = .high
                source.draw(
                    in: NSRect(origin: .zero, size: size),
                    from: NSRect(origin: .zero, size: source.size),
                    operation: .sourceOver,
                    fraction: 1.0
                )
            }
            NSGraphicsContext.restoreGraphicsState()
            let image = NSImage(size: size)
            image.addRepresentation(rep)
            image.isTemplate = false
            return image
        }

        return fallbackSymbolImage(size: size)
    }

    private static func fallbackSymbolImage(size: NSSize = NSSize(width: 16, height: 16)) -> NSImage {
        let config = NSImage.SymbolConfiguration(pointSize: min(size.width, size.height) * 0.9, weight: .medium)
        if let base = NSImage(systemSymbolName: "circle.hexagongrid.circle.fill", accessibilityDescription: "AgentsBar")?
            .withSymbolConfiguration(config) {
            let image = NSImage(size: size)
            image.lockFocus()
            let rect = NSRect(
                x: (size.width - base.size.width) / 2,
                y: (size.height - base.size.height) / 2,
                width: base.size.width,
                height: base.size.height
            )
            base.draw(in: rect)
            image.unlockFocus()
            image.isTemplate = true
            return image
        }
        let empty = NSImage(size: size)
        empty.isTemplate = true
        return empty
    }

    private static func ringNSColor(_ ring: AppModel.StatusRing) -> NSColor? {
        switch ring {
        case .none: return nil
        case .running:
            return NSColor(calibratedRed: 0.22, green: 0.90, blue: 0.48, alpha: 1)
        case .waiting:
            return NSColor(calibratedRed: 1.0, green: 0.42, blue: 0.18, alpha: 1)
        case .completedFlash:
            return NSColor(calibratedRed: 1.0, green: 0.28, blue: 0.32, alpha: 1)
        }
    }

    private static func loadFallback() -> NSImage? {
        Bundle.main.url(forResource: "MenuBarLogo", withExtension: "png")
            .flatMap { NSImage(contentsOf: $0) }
    }
}

import DroidexCore
import SwiftUI
import UIKit

// Dark values mirror src/index.css. Light values preserve the same neutral hierarchy.
enum DroidTheme {
    static let background = adaptive(light: 0xFAFAFA, dark: 0x0A0A0A)
    static let surface = adaptive(light: 0xF1F1F1, dark: 0x111111)
    static let elevated = adaptive(light: 0xE9E9E9, dark: 0x1E1E1E)
    static let text = adaptive(light: 0x191919, dark: 0xEDEDED)
    static let secondary = adaptive(light: 0x626262, dark: 0x9A9A9A)
    static let separator = adaptive(light: 0xDDDDDD, dark: 0x292929)
    static let success = adaptive(light: 0x227547, dark: 0x4FAE82)
    static let warning = adaptive(light: 0x925700, dark: 0xD9913A)
    static let danger = adaptive(light: 0xAC332D, dark: 0xCF5D54)

    private static func adaptive(light: UInt, dark: UInt) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 255) / 255,
                green: CGFloat((hex >> 8) & 255) / 255,
                blue: CGFloat(hex & 255) / 255, alpha: 1
            )
        })
    }
}

struct GlassChrome: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    var cornerRadius: CGFloat = 28
    var interactive = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if reduceTransparency || contrast == .increased {
            content.background(DroidTheme.elevated, in: shape)
                .overlay(shape.strokeBorder(DroidTheme.secondary.opacity(0.5), lineWidth: 1))
        } else {
            content.glassEffect(.regular.interactive(interactive), in: shape)
        }
    }
}

extension SessionPhase {
    var title: String {
        switch self {
        case .ready: "Ready to start"
        case .running: "Working"
        case .needsApproval: "Needs your approval"
        case .needsAnswer: "Needs your answer"
        case .completed: "Ready"
        case .stopped: "Stopped"
        case .failed: "Needs attention"
        }
    }

    var symbol: String {
        switch self {
        case .ready: "circle.dotted"
        case .running: "circle.dotted.circle"
        case .needsApproval, .needsAnswer: "hand.raised"
        case .completed: "checkmark.circle"
        case .stopped: "stop.circle"
        case .failed: "exclamationmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .completed: DroidTheme.success
        case .needsApproval, .needsAnswer: DroidTheme.warning
        case .failed: DroidTheme.danger
        default: DroidTheme.secondary
        }
    }
}

struct PhaseLabel: View {
    let phase: SessionPhase

    var body: some View {
        Label(phase.title, systemImage: phase.symbol)
            .font(.caption)
            .foregroundStyle(phase.color)
            .accessibilityIdentifier("session.phase")
    }
}

struct DiffCounts: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 5) {
            Text("+\(additions)").foregroundStyle(DroidTheme.success)
            Text("−\(deletions)").foregroundStyle(DroidTheme.danger)
        }
        .font(.caption.weight(.medium))
        .monospacedDigit()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

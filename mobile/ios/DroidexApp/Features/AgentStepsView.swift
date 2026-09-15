import SwiftUI

struct AgentStepsView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let steps: [String]
    let isRunning: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) { expanded.toggle() } } label: {
                HStack(spacing: 9) {
                    activityMark
                    VStack(alignment: .leading, spacing: 2) {
                        Text(isRunning ? "Working" : "Agent activity")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(DroidTheme.text)
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(DroidTheme.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(DroidTheme.secondary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .contentShape(Rectangle())
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Hide agent activity" : "Show agent activity")

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 11) {
                            VStack(spacing: 0) {
                                Circle()
                                    .fill(index == steps.count - 1 && isRunning ? DroidTheme.text : DroidTheme.secondary)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 6)
                                if index < steps.count - 1 {
                                    Rectangle()
                                        .fill(DroidTheme.separator)
                                        .frame(width: 1, height: 28)
                                }
                            }
                            Text(step)
                                .font(.footnote)
                                .foregroundStyle(index == steps.count - 1 ? DroidTheme.text : DroidTheme.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.bottom, index < steps.count - 1 ? 8 : 2)
                        }
                    }
                }
                .padding(.leading, 5)
                .padding(.top, 4)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(DroidTheme.surface.opacity(0.72), in: RoundedRectangle(cornerRadius: 13))
        .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(DroidTheme.separator.opacity(0.7)))
    }

    private var summary: String {
        guard let last = steps.last else { return "Preparing" }
        if steps.count == 1 { return last }
        return "\(steps.count) steps · \(last)"
    }

    @ViewBuilder private var activityMark: some View {
        if isRunning {
            ProgressView().controlSize(.mini).frame(width: 15, height: 15)
        } else {
            Circle().strokeBorder(DroidTheme.secondary, lineWidth: 1).frame(width: 12, height: 12)
        }
    }
}

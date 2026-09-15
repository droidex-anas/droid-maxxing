import DroidexCore
import SwiftUI

struct HarnessControl: View {
    @Environment(SessionStore.self) private var store
    @Binding var configuration: SessionConfiguration

    var body: some View {
        if store.isRemote {
            Text("Droid").font(.caption.weight(.medium))
                .accessibilityLabel("Harness: Droid. Other harnesses are not connected in this build.")
        } else {
            Menu {
                ForEach(Harness.allCases, id: \.self) { harness in
                    Button(harness.rawValue) {
                        configuration.harness = harness
                        if !ModelChoice.options(for: harness).contains(configuration.model) {
                            configuration.model = ModelChoice.options(for: harness)[0]
                        }
                    }
                }
            } label: { TextConfigLabel(configuration.harness.rawValue) }
        }
    }
}

struct ModelControl: View {
    @Environment(SessionStore.self) private var store
    @Binding var configuration: SessionConfiguration

    var body: some View {
        Menu {
            if store.isRemote {
                ForEach(store.models) { model in
                    Button(model.name) {
                        configuration.remoteModelID = model.id
                        if !model.efforts.contains(configuration.remoteEffort ?? "") {
                            configuration.remoteEffort = model.defaultEffort ?? model.efforts.first
                        }
                    }
                }
            } else {
                ForEach(ModelChoice.options(for: configuration.harness), id: \.self) { model in
                    Button(model.rawValue) { configuration.model = model }
                }
            }
        } label: { TextConfigLabel(store.modelName(configuration)) }
        .disabled(store.isRemote && store.models.isEmpty)
        .accessibilityLabel("Model")
        .accessibilityValue(store.modelName(configuration))
        .accessibilityIdentifier("configuration.model")
    }
}

struct EffortControl: View {
    @Environment(SessionStore.self) private var store
    @Binding var configuration: SessionConfiguration
    @State private var presented = false

    private var available: [String] {
        store.isRemote ? store.models.first { $0.id == configuration.remoteModelID }?.efforts ?? []
            : ReasoningEffort.allCases.map { String($0.rawValue) }
    }

    var body: some View {
        Button { presented = true } label: { TextConfigLabel(store.effortName(configuration)) }
            .buttonStyle(.plain)
            .disabled(available.isEmpty)
            .accessibilityLabel("Reasoning effort")
            .accessibilityValue(store.effortName(configuration))
            .accessibilityIdentifier("configuration.effort")
            .popover(isPresented: $presented, arrowEdge: .bottom) {
                EffortPicker(configuration: $configuration, levels: available)
                    .presentationCompactAdaptation(.popover)
            }
    }
}

struct TextConfigLabel: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        HStack(spacing: 5) {
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(DroidTheme.text)
        .padding(.horizontal, 4)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

private struct EffortPicker: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @Binding var configuration: SessionConfiguration
    let levels: [String]

    private var selected: String { store.isRemote ? configuration.remoteEffort ?? "" : String(configuration.reasoning.rawValue) }
    private func title(_ level: String) -> String {
        store.isRemote ? SessionStore.effortTitle(level) : ReasoningEffort(rawValue: Int(level) ?? 0)?.title ?? level
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Reasoning effort").font(.subheadline.weight(.semibold))
                Spacer()
                Text(store.effortName(configuration)).font(.caption).foregroundStyle(DroidTheme.secondary)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(DroidTheme.separator).frame(height: 2)
                    let position = Double(levels.firstIndex(of: selected) ?? 0) / Double(max(1, levels.count - 1))
                    Capsule().fill(DroidTheme.text).frame(width: geometry.size.width * position, height: 2)
                    HStack(spacing: 0) {
                        ForEach(Array(levels.enumerated()), id: \.element) { index, level in
                            if index != 0 { Spacer(minLength: 0) }
                            Circle().fill(level == selected ? DroidTheme.text : DroidTheme.elevated)
                                .overlay(Circle().strokeBorder(DroidTheme.secondary, lineWidth: level == selected ? 0 : 1))
                                .frame(width: level == selected ? 18 : 8, height: level == selected ? 18 : 8)
                        }
                    }
                }
                .frame(height: 44)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                    guard !levels.isEmpty, geometry.size.width > 0 else { return }
                    let fraction = min(1, max(0, value.location.x / geometry.size.width))
                    choose(levels[Int((fraction * Double(levels.count - 1)).rounded())])
                })
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Reasoning effort")
                .accessibilityValue(store.effortName(configuration))
                .accessibilityAdjustableAction { direction in
                    guard let index = levels.firstIndex(of: selected) else { return }
                    switch direction {
                    case .increment: choose(levels[min(levels.count - 1, index + 1)])
                    case .decrement: choose(levels[max(0, index - 1)])
                    @unknown default: break
                    }
                }
            }
            .frame(height: 44)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 68))], spacing: 6) {
                ForEach(levels, id: \.self) { level in
                    Button(title(level)) { choose(level) }
                        .font(.caption.weight(level == selected ? .semibold : .regular))
                        .foregroundStyle(level == selected ? DroidTheme.text : DroidTheme.secondary)
                        .frame(minHeight: 44)
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(level == selected ? .isSelected : [])
                }
            }
            Text(store.isRemote ? "Levels supported by this model on your computer." : "Preview configuration. No provider is connected.")
                .font(.caption).foregroundStyle(DroidTheme.secondary)
        }
        .padding(20)
        .frame(idealWidth: 320, maxWidth: 360)
        .presentationBackground(.regularMaterial)
        .sensoryFeedback(.selection, trigger: selected) { _, _ in hapticsEnabled }
    }

    private func choose(_ level: String) {
        guard level != selected else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) {
            if store.isRemote { configuration.remoteEffort = level }
            else if let value = Int(level), let effort = ReasoningEffort(rawValue: value) { configuration.reasoning = effort }
        }
    }
}

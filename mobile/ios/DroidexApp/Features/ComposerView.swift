import DroidexCore
import SwiftUI

struct ComposerView: View {
    @Environment(SessionStore.self) private var store
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @Binding var text: String
    @Binding var configuration: SessionConfiguration
    let phase: SessionPhase
    let send: () -> Void
    let stop: () -> Void

    private var canSubmit: Bool {
        store.canSend && phase.canSend && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.trimmingCharacters(in: .whitespacesAndNewlines).count <= SessionStore.promptLimit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Follow up…", text: $text, axis: .vertical)
                    .font(.body).lineLimit(1...5).frame(minHeight: 44)
                    .textInputAutocapitalization(.sentences)
                    .disabled(phase.approval != nil || phase.question != nil)
                    .accessibilityLabel("Message").accessibilityIdentifier("composer.input")
                HStack(alignment: .bottom, spacing: 10) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { model; effort }.fixedSize(horizontal: true, vertical: false)
                        VStack(alignment: .leading, spacing: 0) { model; effort }
                    }
                    .disabled(!phase.canSend || !store.canSend)
                    Spacer(minLength: 0)
                    Button { if phase.isRunning { stop() } else { send() } } label: {
                        Image(systemName: phase.isRunning ? "stop.fill" : "arrow.up")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .foregroundStyle(DroidTheme.background)
                            .background(canSubmit || phase.isRunning ? DroidTheme.text : DroidTheme.secondary, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!store.canSend || (!phase.isRunning && !canSubmit))
                    .accessibilityLabel(phase.isRunning ? "Stop response" : "Send message")
                    .accessibilityIdentifier(phase.isRunning ? "composer.stop" : "composer.send")
                    .keyboardShortcut(.return, modifiers: .command)
                }
                HStack(spacing: 10) {
                    HarnessControl(configuration: $configuration)
                    Picker("Mode", selection: $configuration.interactionMode) {
                        ForEach(InteractionMode.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented).frame(maxWidth: 165)
                    .disabled(!phase.canSend || !store.canSend)
                    Spacer(minLength: 0)
                    Text(store.isRemote ? "Remote" : "Preview").font(.caption2).foregroundStyle(DroidTheme.secondary)
                }
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            .modifier(GlassChrome())
            if text.count > SessionStore.promptLimit {
                Text("Keep your message under \(SessionStore.promptLimit.formatted()) characters.")
                    .font(.footnote).foregroundStyle(DroidTheme.danger).padding(.horizontal, 8)
            } else if phase.approval != nil || phase.question != nil {
                Text("Respond to the pending action before sending another message.")
                    .font(.footnote).foregroundStyle(DroidTheme.secondary).padding(.horizontal, 8)
            }
        }
        .sensoryFeedback(.selection, trigger: configuration.remoteModelID) { _, _ in hapticsEnabled }
    }
    private var model: some View { ModelControl(configuration: $configuration) }
    private var effort: some View { EffortControl(configuration: $configuration) }
}

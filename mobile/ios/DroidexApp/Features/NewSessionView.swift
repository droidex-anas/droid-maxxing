import DroidexCore
import SwiftUI

struct NewSessionView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var prompt = ""
    @State private var configuration = SessionConfiguration()
    let onCreate: (UUID) -> Void

    private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canStart: Bool {
        store.canSend && !trimmedPrompt.isEmpty && trimmedPrompt.count <= SessionStore.promptLimit
            && (!store.isRemote || configuration.remoteModelID != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(store.workspaceName).font(.subheadline).foregroundStyle(DroidTheme.secondary)
                    TextField("Plan, ask, build…", text: $prompt, axis: .vertical)
                        .font(.body).lineLimit(4...10).focused($focused)
                        .accessibilityLabel("New session message").accessibilityIdentifier("new-session.prompt")
                } footer: {
                    if trimmedPrompt.count > SessionStore.promptLimit {
                        Text("Keep your message under \(SessionStore.promptLimit.formatted()) characters.")
                            .foregroundStyle(DroidTheme.danger)
                    }
                }
                Section("Configuration") {
                    LabeledContent("Harness") { HarnessControl(configuration: $configuration) }
                    LabeledContent("Model") { ModelControl(configuration: $configuration) }
                    LabeledContent("Reasoning") { EffortControl(configuration: $configuration) }
                    Picker("Mode", selection: $configuration.interactionMode) {
                        ForEach(InteractionMode.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                }
                if store.isRemote {
                    Section {
                        Text(store.computerName).font(.subheadline)
                        Text(store.isConnected ? "Connected on your private network" : "Computer disconnected")
                            .foregroundStyle(DroidTheme.secondary)
                        if store.models.isEmpty {
                            Text("No models are available yet. Log in to Droid on the computer, then refresh the connection.")
                            Button("Refresh models") { Task { await store.reconnect() } }
                        }
                    } footer: {
                        Text("Uses your computer’s provider account and quota. Approvals stay enabled. Any command or edit you approve runs on that computer.")
                    }
                } else {
                    Section {
                        Text("Offline preview")
                    } footer: {
                        Text("Scripted responses and sample diffs. Model and harness choices here are demonstrations, not live connections.")
                    }
                }
            }
            .scrollContentBackground(.hidden).background(DroidTheme.background)
            .navigationTitle("New session").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        guard canStart, let id = store.createSession(configuration: configuration) else { return }
                        store.send(trimmedPrompt, to: id)
                        onCreate(id)
                        dismiss()
                    }
                    .fontWeight(.semibold).disabled(!canStart).accessibilityIdentifier("new-session.start")
                }
            }
            .task { configuration = store.defaultConfiguration; focused = true }
            .onChange(of: store.models) { _, _ in
                if configuration.remoteModelID == nil { configuration = store.defaultConfiguration }
            }
        }
        .interactiveDismissDisabled(!prompt.isEmpty)
    }
}

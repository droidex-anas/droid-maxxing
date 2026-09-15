import DroidexCore
import SwiftUI

struct SettingsView: View {
    @Environment(SessionStore.self) private var store
    @Environment(AppConnection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearance = "system"
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @State private var confirmReset = false
    @State private var confirmDisconnect = false
    let onReset: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    BrandMark().frame(width: 146, height: 20).padding(.vertical, 12)
                    LabeledContent("Build", value: store.isRemote ? "Connected MVP · 0.2" : "Offline preview · 0.2")
                }
                Section {
                    Picker("Theme", selection: $appearance) {
                        Text("System").tag("system")
                        Text("Dark").tag("dark")
                        Text("Light").tag("light")
                    }
                    Toggle("Haptic feedback", isOn: $hapticsEnabled)
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Feedback is reserved for selections, sending, stopping, and results. Reduce Motion and Reduce Transparency follow your system settings.")
                }
                if store.isRemote {
                    Section("Computer") {
                        LabeledContent("Name", value: store.computerName)
                        LabeledContent("Workspace", value: store.workspaceName)
                        LabeledContent("Connection", value: store.isConnected ? "Connected" : "Disconnected")
                        Text("This build connects to Droid on your computer. Work continues when this phone is locked. Provider credentials remain on the desktop.")
                            .font(.callout).foregroundStyle(DroidTheme.secondary)
                        Button("Refresh connection and models") { Task { await store.reconnect() } }
                        Button("Forget this computer", role: .destructive) { confirmDisconnect = true }
                    }
                    if let error = connection.error { Text(error).foregroundStyle(DroidTheme.danger) }
                } else {
                    Section("Runtime") {
                        LabeledContent("Connection", value: "Offline preview")
                        Text("Scripted responses and sample diffs. No commands run in preview mode.")
                            .font(.callout).foregroundStyle(DroidTheme.secondary)
                        Button("Add a computer") { Task { await connection.forget() } }
                    }
                    Section {
                        Button("Reset local preview", role: .destructive) { confirmReset = true }
                    } footer: {
                        Text("Replaces only the saved demonstration conversations. Your repository is untouched.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(DroidTheme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Forget this computer?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
                Button("Forget computer", role: .destructive) { Task { await connection.forget() } }
            } message: {
                Text("This removes the credential from this phone. To stop work and revoke access, choose Disable in the computer’s Connect phone window.")
            }
            .confirmationDialog("Replace all local preview conversations?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Reset local preview", role: .destructive) {
                    Task {
                        await store.resetPreview()
                        onReset()
                        dismiss()
                    }
                }
            }
        }
    }
}

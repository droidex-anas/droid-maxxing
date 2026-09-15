import DroidexCore
import SwiftUI
import UIKit

struct OnboardingView: View {
    @Environment(AppConnection.self) private var connection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @State private var showsCode = false
    @State private var code = ""
    @State private var waiting = false
    @State private var error: String?
    @State private var pairing: Task<Void, Never>?
    @State private var feedback = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    BrandMark().frame(width: 110, height: 16).padding(.top, 24)
                    Spacer(minLength: 12)
                    VStack(alignment: .leading, spacing: 16) {
                        Text(waiting ? "One last step.\nApprove on your computer." : "Your workspace.\nWherever you sit.")
                            .font(.system(.largeTitle, design: .default).weight(.semibold))
                            .tracking(-1)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(waiting
                             ? "DROIDEX is waiting for you to confirm this phone on the desktop. No account password or API key is needed here."
                             : "Connect your computer and use its agents from your phone. Real sessions, live progress, and changes you can review.")
                            .font(.body).lineSpacing(4).foregroundStyle(DroidTheme.secondary)
                    }
                    RemoteOnboardingArtwork(step: waiting ? 2 : nil)
                    if showsCode && !waiting {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text("Pairing code").font(.subheadline.weight(.medium))
                                Spacer()
                                PasteButton(payloadType: String.self) { values in
                                    if let value = values.first { code = value }
                                }
                                .buttonBorderShape(.capsule)
                            }
                            TextField("DX1.…", text: $code, axis: .vertical)
                                .lineLimit(2...4)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(16)
                                .background(DroidTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                                .accessibilityIdentifier("pairing.code")
                                .privacySensitive()
                            Text("The single-use code pins this computer’s encrypted connection. Share it only with your own phone.")
                                .font(.footnote).foregroundStyle(DroidTheme.secondary)
                        }
                    }
                    if let message = error ?? connection.error {
                        Text(message).font(.callout).foregroundStyle(DroidTheme.danger)
                            .accessibilityIdentifier("pairing.error")
                    }
                    if waiting {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Waiting for desktop approval").font(.subheadline)
                        }
                        Button("Cancel pairing") {
                            pairing?.cancel()
                            waiting = false
                            error = "Pairing cancelled. Generate a new code on the computer before trying again."
                        }.buttonStyle(.plain).frame(minHeight: 44)
                    } else {
                        Button(showsCode ? "Connect to computer" : "Add computer") {
                            if showsCode { pair() }
                            else { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { showsCode = true } }
                        }
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .foregroundStyle(DroidTheme.background)
                        .background(DroidTheme.text, in: Capsule())
                        .buttonStyle(.plain)
                        .disabled(showsCode && code.isEmpty)
                        .accessibilityIdentifier("pairing.connect")
                        Button("Explore the offline preview") { connection.preview() }
                            .font(.subheadline).foregroundStyle(DroidTheme.secondary)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    Text("Your computer does the work and must remain awake. Closing the phone does not stop a connected run.")
                        .font(.footnote).foregroundStyle(DroidTheme.secondary)
                        .padding(.bottom, 24)
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 28)
                .frame(maxWidth: .infinity)
            }
            .background(DroidTheme.background)
            .foregroundStyle(DroidTheme.text)
            .scrollDismissesKeyboard(.interactively)
            .sensoryFeedback(.success, trigger: feedback) { _, _ in hapticsEnabled }
            .onDisappear { pairing?.cancel() }
        }
    }

    private func pair() {
        error = nil
        do {
            let parsed = try PairingCode.parse(code)
            waiting = true
            pairing = Task {
                do {
                    let credential = try await DesktopConnection.pair(code: parsed, name: UIDevice.current.name)
                    try Task.checkCancellation()
                    try connection.connect(credential)
                    feedback += 1
                } catch {
                    guard !Task.isCancelled else { return }
                    self.error = error.localizedDescription + (error is RemoteFailure ? "" : " Check local-network permission, the firewall, and that both devices are on the same Wi-Fi.")
                }
                waiting = false
            }
        } catch { self.error = error.localizedDescription }
    }
}

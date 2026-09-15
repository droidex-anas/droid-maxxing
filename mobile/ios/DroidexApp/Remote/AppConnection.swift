import DroidexCore
import Foundation
import Observation

@MainActor
@Observable
final class AppConnection {
    var store: SessionStore?
    var error: String?
    private var restored = false

    init() {
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            store = SessionStore()
            restored = true
        }
    }

    func restore() {
        guard !restored else { return }
        restored = true
        do {
            if let credential = try CredentialVault.load() {
                store = SessionStore(desktop: try DesktopConnection(credential: credential))
            }
        } catch { self.error = error.localizedDescription }
    }

    func connect(_ credential: DesktopCredential) throws {
        let service = try DesktopConnection(credential: credential)
        try CredentialVault.save(credential)
        store = SessionStore(desktop: service)
        error = nil
    }

    func preview() {
        store = SessionStore(archiveURL: URL.applicationSupportDirectory.appending(path: "DROIDEX/sessions.json"))
    }

    func forget() async {
        do {
            try CredentialVault.delete()
            await store?.suspend()
            store = nil
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

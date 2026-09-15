import Foundation
import Testing
@testable import DroidexCore

struct SessionArchiveTests {
    @Test func latestRevisionWinsAndInterruptedRunsRestoreStopped() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let archive = SessionArchive(url: directory.appendingPathComponent("sessions.json"))
        let session = AgentSession(
            title: "Keep this", configuration: .init(harness: .claude, interactionMode: .spec),
            phase: .running(UUID()), draft: "Unsent work"
        )
        try await archive.save([session], revision: 2)
        try await archive.save([], revision: 1)
        let restored = try #require(try await archive.load()?.first)
        #expect(restored.appSessionId == session.appSessionId)
        #expect(restored.configuration == session.configuration)
        #expect(restored.draft == "Unsent work")
        #expect(restored.phase == .stopped)
        #expect(restored.messages.last?.text.contains("interrupted") == true)
    }

    @Test @MainActor func damagedArchiveIsNotOverwrittenByLoadOrFlush() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("sessions.json")
        let original = Data("not valid JSON".utf8)
        try original.write(to: url)
        let store = SessionStore(archiveURL: url)
        await store.load()
        guard case .failed = store.loadState else { Issue.record("Expected a load failure"); return }
        #expect(store.createSession() == nil)
        await store.flush()
        #expect(try Data(contentsOf: url) == original)
    }

    @Test @MainActor func draftsAndRenamesSurviveAStoreRelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("sessions.json")
        let store = SessionStore(archiveURL: url)
        await store.load()
        let id = try #require(store.createSession())
        store.setDraft("An unfinished thought", for: id)
        store.rename(id, to: "Mobile polish")
        await store.flush()
        let relaunched = SessionStore(archiveURL: url)
        await relaunched.load()
        #expect(relaunched.session(id)?.draft == "An unfinished thought")
        #expect(relaunched.session(id)?.title == "Mobile polish")
    }
}

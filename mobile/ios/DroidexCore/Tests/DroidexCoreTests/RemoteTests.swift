import Foundation
import Testing
@testable import DroidexCore

private let computerID = UUID(uuidString: "55555555-5555-4555-8555-555555555555")!

@MainActor
private func fixture(id: UUID? = nil, revision: Int = 2, phase: String = "completed", text: String = "The workspace is ready.") throws -> RemoteSession {
    let url = Bundle.module.url(forResource: "session", withExtension: "json", subdirectory: "Fixtures")!
    var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    if let id { object["id"] = id.uuidString }
    object["revision"] = revision
    object["phase"] = phase
    var messages = object["messages"] as! [[String: Any]]
    messages[1]["text"] = text
    object["messages"] = messages
    if phase == "approval" {
        object["approval"] = ["id": UUID().uuidString, "title": "Run tests?", "detail": "swift test"]
    }
    if phase == "question" {
        object["question"] = ["id": UUID().uuidString, "questions": [["index": 3, "question": "Which target?", "options": ["App", "Core"]]]]
    }
    return try JSONDecoder().decode(RemoteSession.self, from: JSONSerialization.data(withJSONObject: object))
}

@MainActor
private final class Desktop: DesktopService {
    var sessions: [RemoteSession] = []
    var sent: [RemoteTurn] = []
    var stops: [UUID] = []
    var approvals: [(UUID, UUID, Bool)] = []
    var answers: [(UUID, UUID, [String])] = []
    var removed: [UUID] = []
    var continuations: [AsyncThrowingStream<RemoteEvent, Error>.Continuation] = []
    var bootstrapError: Error?
    var sendError: Error?

    func bootstrap() async throws -> RemoteBootstrap {
        if let bootstrapError { throw bootstrapError }
        let data = try JSONSerialization.data(withJSONObject: [
            "version": 1, "computerId": computerID.uuidString, "computerName": "Test computer", "workspace": "workspace",
            "models": [["id": "test-model", "name": "Installed model", "efforts": ["low", "high"], "defaultEffort": "high"]],
            "sessions": try JSONSerialization.jsonObject(with: JSONEncoder().encode(sessions)),
        ])
        return try JSONDecoder().decode(RemoteBootstrap.self, from: data)
    }
    func updates() -> AsyncThrowingStream<RemoteEvent, Error> {
        AsyncThrowingStream { continuation in
            continuations.append(continuation)
            continuation.yield(.snapshot(sessions))
        }
    }
    func send(_ turn: RemoteTurn) async throws { sent.append(turn); if let sendError { throw sendError } }
    func stop(_ id: UUID) async throws { stops.append(id) }
    func approve(_ approvalID: UUID, in sessionID: UUID, allow: Bool) async throws { approvals.append((approvalID, sessionID, allow)) }
    func answer(_ questionID: UUID, in sessionID: UUID, answers: [String]) async throws { self.answers.append((questionID, sessionID, answers)) }
    func remove(_ id: UUID) async throws { removed.append(id) }
    func emit(_ event: RemoteEvent) { continuations.last?.yield(event) }
}

@MainActor
private func drain() async { for _ in 0..<40 { await Task.yield() } }

@Suite @MainActor
struct RemoteTests {
    @Test func connectedStoreNeverLoadsBundledConversations() async throws {
        let desktop = Desktop()
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        #expect(store.isRemote && store.isConnected)
        #expect(store.sessions.isEmpty)
        #expect(store.defaultConfiguration.remoteModelID == "test-model")
        #expect(store.defaultConfiguration.remoteEffort == "high")
        await store.resetPreview()
        #expect(store.sessions.isEmpty)
        await store.suspend()
    }

    @Test func sendUsesRealCatalogSelectionAndDoesNotInventAResponse() async throws {
        let desktop = Desktop()
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        let id = try #require(store.createSession(configuration: store.defaultConfiguration))
        await store.send("Inspect the workspace", to: id)?.value
        #expect(desktop.sent.count == 1)
        #expect(desktop.sent.first?.modelId == "test-model")
        #expect(desktop.sent.first?.effort == "high")
        #expect(store.session(id)?.messages.isEmpty == true)
        desktop.emit(.session(try fixture(id: id)))
        await drain()
        #expect(store.session(id)?.messages.last?.text == "The workspace is ready.")
        #expect(store.session(id)?.phase == .completed)
        await store.suspend()
    }

    @Test func backgroundingDetachesAndReconnectRestoresWithoutStoppingOrResending() async throws {
        let desktop = Desktop()
        let running = try fixture(revision: 1, phase: "running", text: "Partial")
        desktop.sessions = [running]
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        let stale = try #require(desktop.continuations.first)
        await store.suspend()
        #expect(desktop.stops.isEmpty)
        #expect(!store.isConnected)
        desktop.sessions = [try fixture(revision: 3, text: "Finished while the phone was locked")]
        await store.reconnect(); await drain()
        stale.yield(.session(try fixture(revision: 100, text: "Stale connection")))
        await drain()
        #expect(store.session(running.id)?.messages.last?.text == "Finished while the phone was locked")
        #expect(desktop.sent.isEmpty)
        await store.suspend()
    }

    @Test func approvalsAndQuestionsWaitForDesktopStateRatherThanMockCompletion() async throws {
        let desktop = Desktop()
        let pending = try fixture(phase: "approval")
        desktop.sessions = [pending]
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        let approval = try #require(store.session(pending.id)?.phase.approval)
        store.respond(to: approval.id, in: pending.id, allow: true)
        await drain()
        #expect(desktop.approvals.count == 1)
        #expect(store.session(pending.id)?.phase.approval?.id == approval.id)
        #expect(store.session(pending.id)?.messages.count == 2)
        desktop.emit(.session(try fixture(revision: 3, phase: "question")))
        await drain()
        let question = try #require(store.session(pending.id)?.phase.question)
        store.answer(question.id, in: pending.id, answers: ["Core"])
        await drain()
        #expect(desktop.answers.first?.2 == ["Core"])
        #expect(store.session(pending.id)?.phase.question != nil)
        desktop.emit(.session(try fixture(revision: 4)))
        await drain()
        #expect(store.session(pending.id)?.phase == .completed)
        await store.suspend()
    }

    @Test func oldRevisionsCannotOverwriteNewerText() async throws {
        let desktop = Desktop()
        let value = try fixture()
        desktop.sessions = [value]
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        desktop.emit(.session(try fixture(revision: 8, text: "Latest")))
        desktop.emit(.session(try fixture(revision: 3, text: "Old")))
        await drain()
        #expect(store.session(value.id)?.messages.last?.text == "Latest")
        await store.suspend()
    }

    @Test func uncertainDeliveryRequiresReconnectAndNeverAutomaticallyRetries() async throws {
        let desktop = Desktop()
        desktop.sendError = RemoteFailure("Connection interrupted")
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        let id = try #require(store.createSession(configuration: store.defaultConfiguration))
        await store.send("Inspect the workspace", to: id)?.value
        #expect(!store.isConnected)
        #expect(store.session(id)?.messages.isEmpty == true)
        desktop.sessions = [try fixture(id: id)]
        await store.reconnect(); await drain()
        #expect(desktop.sent.count == 1)
        #expect(store.session(id)?.phase == .completed)
        await store.suspend()
    }

    @Test func reconnectRestoresSameRevisionAfterUncertainFollowup() async throws {
        let desktop = Desktop()
        let value = try fixture()
        desktop.sessions = [value]
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        desktop.sendError = RemoteFailure("Disconnected before acceptance")
        await store.send("Follow up", to: value.id)?.value
        #expect(!store.isConnected)
        #expect(store.session(value.id)?.phase != .completed)
        await store.reconnect(); await drain()
        #expect(store.session(value.id)?.phase == .completed)
        #expect(desktop.sent.count == 1)
        await store.suspend()
    }

    @Test func closeCannotForgetAnUnacknowledgedSend() async throws {
        let desktop = Desktop()
        let store = SessionStore(desktop: desktop)
        await store.load(); await drain()
        let id = try #require(store.createSession(configuration: store.defaultConfiguration))
        await store.send("Inspect the workspace", to: id)?.value
        store.delete(id)
        #expect(store.session(id) != nil)
        #expect(store.connectionError?.contains("acknowledge") == true)
        desktop.emit(.session(try fixture(id: id)))
        await drain()
        store.delete(id)
        await drain()
        #expect(desktop.removed == [id])
        await store.suspend()
    }

    @Test func connectionFailureDoesNotFallBackToDemo() async {
        let desktop = Desktop()
        desktop.bootstrapError = RemoteFailure("Computer is asleep")
        let store = SessionStore(desktop: desktop)
        await store.load()
        #expect(store.loadState == .failed("Computer is asleep"))
        #expect(store.sessions.isEmpty)
        #expect(!store.isConnected)
    }

    @Test func unknownEventsFailVisiblyAndRealDiffCountsSurviveDecoding() throws {
        let value = try fixture()
        let local = value.localSession()
        #expect(local.additions == 1 && local.deletions == 1)
        #expect(local.diffNote?.contains("existing edits") == true)
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(RemoteEvent.self, from: Data("{\"type\":\"unknown\"}".utf8))
        }
    }

    @Test func pairingCodeRejectsPublicUrlsUserInfoAndMalformedIpv4() throws {
        func code(_ address: String) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: [
                "version": 1, "address": address, "fingerprint": String(repeating: "a", count: 64), "ticket": String(repeating: "b", count: 64),
            ])
            return "DX1." + data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        #expect(try PairingCode.parse(code("https://192.168.1.2:44111")).address.host == "192.168.1.2")
        for value in ["http://192.168.1.2:44111", "https://example.com:443", "https://8.8.8.8:443", "https://user@192.168.1.2:443", "https://10.0.bad.0.1:443", "https://192.168.1.2:443/path"] {
            #expect(throws: (any Error).self) { try PairingCode.parse(code(value)) }
        }
    }
}

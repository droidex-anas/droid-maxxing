import Foundation
import Testing
@testable import DroidexCore

@MainActor
private final class ControlledClient: AgentClient {
    private(set) var requests: [TurnRequest] = []
    private(set) var streams: [AsyncThrowingStream<AgentEvent, Error>.Continuation] = []

    func events(for request: TurnRequest) -> AsyncThrowingStream<AgentEvent, Error> {
        requests.append(request)
        return AsyncThrowingStream { streams.append($0) }
    }
}

@MainActor
struct SessionStoreTests {
    @Test func invalidPromptsDoNotStartWork() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let id = try #require(store.createSession())
        #expect(store.send(" \n ", to: id) == nil)
        #expect(store.send(String(repeating: "x", count: SessionStore.promptLimit + 1), to: id) == nil)
        #expect(store.session(id)?.messages.isEmpty == true)
        #expect(client.requests.isEmpty)
    }

    @Test func stoppedRunCannotMutateItsReplacement() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let id = try #require(store.createSession())
        let oldRun = try #require(store.send("First", to: id))
        client.streams[0].yield(.text("Buffered stale output"))
        store.stop(id)
        let newRun = try #require(store.send("Second", to: id))
        client.streams[0].yield(.completed)
        client.streams[0].finish()
        await oldRun.value
        #expect(store.session(id)?.phase.isRunning == true)
        client.streams[1].yield(.text("Fresh output"))
        client.streams[1].yield(.completed)
        client.streams[1].finish()
        await newRun.value
        let session = try #require(store.session(id))
        #expect(session.phase == .completed)
        #expect(session.messages.last?.text == "Fresh output")
        #expect(!session.messages.contains { $0.text.contains("stale") })
    }

    @Test func simultaneousSessionsRemainIsolated() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let firstID = try #require(store.createSession())
        let secondID = try #require(store.createSession(configuration: .init(harness: .codex, interactionMode: .spec)))
        let first = try #require(store.send("First", to: firstID))
        let second = try #require(store.send("Second", to: secondID))
        client.streams[1].yield(.text("Second result"))
        client.streams[1].yield(.completed)
        client.streams[1].finish()
        await second.value
        #expect(store.session(firstID)?.phase.isRunning == true)
        client.streams[0].yield(.text("First result"))
        client.streams[0].yield(.completed)
        client.streams[0].finish()
        await first.value
        #expect(store.session(firstID)?.messages.last?.text == "First result")
        #expect(store.session(secondID)?.messages.last?.text == "Second result")
        #expect(client.requests[1].appSessionId == secondID)
        #expect(client.requests[1].configuration.harness == .codex)
        #expect(client.requests[1].configuration.interactionMode == .spec)
    }

    @Test func approvalIsScopedSingleUseAndBlocksSending() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let id = try #require(store.createSession())
        let run = try #require(store.send("Make a change", to: id))
        let approval = Approval(title: "Review", detail: "Sample only")
        client.streams[0].yield(.approval(approval))
        client.streams[0].yield(.completed)
        client.streams[0].finish()
        await run.value
        #expect(store.session(id)?.phase == .needsApproval(approval))
        #expect(store.send("Another turn", to: id) == nil)
        store.respond(to: UUID(), in: id, allow: true)
        #expect(store.session(id)?.phase == .needsApproval(approval))
        store.respond(to: approval.id, in: id, allow: false)
        let settled = store.session(id)
        #expect(settled?.phase == .stopped)
        store.respond(to: approval.id, in: id, allow: true)
        #expect(store.session(id) == settled)
    }

    @Test func prematureEndIsRecoverableAndPreservesPartialResponse() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let id = try #require(store.createSession())
        let run = try #require(store.send("Read this", to: id))
        client.streams[0].yield(.text("Partial result"))
        client.streams[0].finish()
        await run.value
        let session = try #require(store.session(id))
        guard case .failed = session.phase else { Issue.record("Expected a failed phase"); return }
        #expect(session.phase.canSend)
        #expect(session.messages.last?.text == "Partial result")
        let retry = try #require(store.send("Try again", to: id))
        client.streams[1].yield(.completed)
        client.streams[1].finish()
        await retry.value
        #expect(store.session(id)?.phase == .completed)
    }

    @Test func deletingAnActiveSessionDiscardsBufferedEvents() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let id = try #require(store.createSession())
        let run = try #require(store.send("Start", to: id))
        client.streams[0].yield(.text("Late output"))
        store.delete(id)
        client.streams[0].finish()
        await run.value
        #expect(store.session(id) == nil)
    }

    @Test func backgroundingStopsAllRuns() async throws {
        let client = ControlledClient()
        let store = SessionStore(client: client)
        await store.load()
        let id = try #require(store.createSession())
        let run = try #require(store.send("Start", to: id))
        await store.suspend()
        client.streams[0].finish()
        await run.value
        #expect(store.session(id)?.phase == .stopped)
    }
}

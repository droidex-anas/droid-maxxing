import Foundation
import Observation

@MainActor
@Observable
public final class SessionStore {
    public enum LoadState: Equatable { case loading, ready, failed(String) }

    public private(set) var sessions: [AgentSession] = []
    public private(set) var loadState: LoadState = .loading
    public private(set) var storageError: String?
    public static let promptLimit = 8_000

    public private(set) var models: [RemoteModel] = []
    public private(set) var computerName = ""
    public private(set) var workspaceName = "droid-maxxing"
    public private(set) var isConnected = false
    public private(set) var connectionError: String?
    public var isRemote: Bool { desktop != nil }
    public var canSend: Bool { !isRemote || isConnected }

    @ObservationIgnored private let desktop: (any DesktopService)?
    @ObservationIgnored private var subscription: Task<Void, Never>?
    @ObservationIgnored private var remoteGeneration = 0
    @ObservationIgnored private var remoteRevisions: [UUID: Int] = [:]
    @ObservationIgnored private var knownRemoteIDs: Set<UUID> = []
    @ObservationIgnored private let client: (any AgentClient)?
    @ObservationIgnored private let archive: SessionArchive?
    @ObservationIgnored private var runs: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var pendingSave: Task<Void, Never>?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var loading = false

    public init(client: any AgentClient = DemoAgentClient(), archiveURL: URL? = nil) {
        self.client = client
        self.desktop = nil
        self.archive = archiveURL.map(SessionArchive.init)
    }

    public init(desktop: any DesktopService) {
        self.desktop = desktop
        self.client = nil
        self.archive = nil
    }

    public func load() async {
        if isRemote {
            if !isConnected { await reconnect() }
            return
        }
        guard loadState != .ready, !loading else { return }
        loading = true
        loadState = .loading
        defer { loading = false }
        do {
            sessions = try await archive?.load() ?? DemoContent.sessions()
            loadState = .ready
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    public func session(_ id: UUID) -> AgentSession? {
        sessions.first { $0.appSessionId == id }
    }

    @discardableResult
    public func createSession(title: String = "New session", configuration: SessionConfiguration = .init()) -> UUID? {
        guard loadState == .ready else { return nil }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = AgentSession(
            title: trimmedTitle.isEmpty ? "New session" : String(trimmedTitle.prefix(80)),
            workspace: workspaceName, configuration: configuration
        )
        sessions.insert(session, at: 0)
        scheduleSave()
        return session.appSessionId
    }

    public func setDraft(_ text: String, for id: UUID) {
        guard let index = index(of: id) else { return }
        sessions[index].draft = text
        scheduleSave(after: .milliseconds(400))
    }

    public func configure(_ id: UUID, with configuration: SessionConfiguration) {
        guard let index = index(of: id), sessions[index].phase.canSend else { return }
        sessions[index].configuration = configuration
        scheduleSave()
    }

    public func rename(_ id: UUID, to title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let index = index(of: id) else { return }
        sessions[index].title = String(title.prefix(80))
        scheduleSave()
    }

    public func delete(_ id: UUID) {
        if let desktop {
            if knownRemoteIDs.contains(id) {
                performRemote { try await desktop.remove(id) }
            } else if session(id)?.phase.isRunning == true {
                connectionError = "Wait for the computer to acknowledge this session, or reconnect before closing it."
            } else { sessions.removeAll { $0.id == id } }
            return
        }
        stop(id)
        sessions.removeAll { $0.appSessionId == id }
        scheduleSave()
    }

    @discardableResult
    public func send(_ text: String, to id: UUID) -> Task<Void, Never>? {
        if desktop != nil { return sendRemote(text, to: id) }
        guard let client else { return nil }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard loadState == .ready, !text.isEmpty, text.count <= Self.promptLimit,
              let index = index(of: id), sessions[index].phase.canSend else { return nil }
        let runID = UUID()
        let response = ChatMessage(role: .assistant, text: "")
        let request = TurnRequest(appSessionId: id, text: text, configuration: sessions[index].configuration)
        sessions[index].messages += [.init(role: .user, text: text), response]
        sessions[index].phase = .running(runID)
        sessions[index].draft = ""
        sessions[index].changes = []
        sessions[index].updatedAt = .now
        if sessions[index].title == "New session" { sessions[index].title = String(text.prefix(60)) }
        scheduleSave()
        let events = client.events(for: request)
        let task = Task { [weak self] in
            do {
                for try await event in events {
                    guard !Task.isCancelled, let self, self.isCurrent(id, runID: runID) else { return }
                    if self.apply(event, to: id, responseID: response.id) { return }
                }
                guard let self, self.isCurrent(id, runID: runID) else { return }
                self.fail(id, message: "The preview ended without a result. Please send the message again.")
            } catch {
                guard let self, self.isCurrent(id, runID: runID) else { return }
                if error is CancellationError {
                    self.stop(id)
                } else {
                    self.fail(id, message: "The preview could not finish. Please send the message again.")
                }
            }
        }
        runs[id] = task
        return task
    }

    public func stop(_ id: UUID) {
        if let desktop {
            performRemote { try await desktop.stop(id) }
            return
        }
        guard let index = index(of: id), sessions[index].phase.isRunning else { return }
        // Invalidate first: cancellation may still allow buffered events to arrive.
        sessions[index].phase = .stopped
        let task = runs.removeValue(forKey: id)
        task?.cancel()
        if sessions[index].messages.last?.text.isEmpty == true {
            sessions[index].messages[sessions[index].messages.count - 1].text = "Stopped before a response."
        }
        sessions[index].updatedAt = .now
        scheduleSave()
    }

    public func respond(to approvalID: UUID, in id: UUID, allow: Bool) {
        if let desktop {
            performRemote { try await desktop.approve(approvalID, in: id, allow: allow) }
            return
        }
        guard let index = index(of: id), sessions[index].phase.approval?.id == approvalID else { return }
        sessions[index].phase = allow ? .completed : .stopped
        let text = allow
            ? "Preview approved. No commands were run and no repository files were changed."
            : "Preview declined. No commands were run and no repository files were changed."
        sessions[index].messages.append(.init(role: .assistant, text: text))
        sessions[index].updatedAt = .now
        scheduleSave()
    }

    public func suspend() async {
        if isRemote {
            remoteGeneration += 1
            subscription?.cancel()
            subscription = nil
            loading = false
            isConnected = false
            return
        }
        for id in Array(runs.keys) { stop(id) }
        await flush()
    }

    public func flush() async {
        scheduleSave()
        await pendingSave?.value
    }

    public func resetPreview() async {
        guard !isRemote else { return }
        for id in Array(runs.keys) { stop(id) }
        sessions = DemoContent.sessions()
        loadState = .ready
        await flush()
    }

    private func index(of id: UUID) -> Int? { sessions.firstIndex { $0.appSessionId == id } }

    private func isCurrent(_ id: UUID, runID: UUID) -> Bool {
        session(id)?.phase == .running(runID)
    }

    private func apply(_ event: AgentEvent, to id: UUID, responseID: UUID) -> Bool {
        guard let index = index(of: id),
              let messageIndex = sessions[index].messages.firstIndex(where: { $0.id == responseID }) else { return true }
        switch event {
        case .step(let step): sessions[index].messages[messageIndex].steps.append(step)
        case .text(let text): sessions[index].messages[messageIndex].text += text
        case .changes(let changes): sessions[index].changes = changes
        case .approval(let approval): sessions[index].phase = .needsApproval(approval)
        case .completed: sessions[index].phase = .completed
        }
        let settled = !sessions[index].phase.isRunning
        if settled {
            runs.removeValue(forKey: id)
            sessions[index].updatedAt = .now
            scheduleSave()
        }
        return settled
    }

    private func fail(_ id: UUID, message: String) {
        guard let index = index(of: id) else { return }
        runs.removeValue(forKey: id)
        sessions[index].phase = .failed(message)
        sessions[index].updatedAt = .now
        scheduleSave()
    }

    private func scheduleSave(after delay: Duration = .zero) {
        guard loadState == .ready, let archive else { return }
        revision += 1
        let revision = revision
        let snapshot = sessions
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            do {
                if delay != .zero { try await Task.sleep(for: delay) }
                try Task.checkCancellation()
                try await archive.save(snapshot, revision: revision)
                guard let self, self.revision == revision else { return }
                self.storageError = nil
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.revision == revision else { return }
                self.storageError = "Your changes are in memory but could not be saved. Check available storage and try again."
            }
        }
    }
    public var defaultConfiguration: SessionConfiguration {
        var result = SessionConfiguration()
        if let model = models.first {
            result.remoteModelID = model.id
            result.remoteEffort = model.defaultEffort ?? model.efforts.first
        }
        return result
    }

    public func modelName(_ configuration: SessionConfiguration) -> String {
        guard isRemote else { return configuration.model.rawValue }
        return models.first { $0.id == configuration.remoteModelID }?.name ?? configuration.remoteModelID ?? "Choose model"
    }

    public func effortName(_ configuration: SessionConfiguration) -> String {
        guard isRemote else { return configuration.reasoning.title }
        return configuration.remoteEffort.map(Self.effortTitle) ?? "Provider default"
    }

    public static func effortTitle(_ value: String) -> String {
        value == "xhigh" ? "Extra high" : value.capitalized
    }

    public func answer(_ questionID: UUID, in sessionID: UUID, answers: [String]) {
        guard let desktop else { return }
        performRemote { try await desktop.answer(questionID, in: sessionID, answers: answers) }
    }

    public func reconnect() async {
        guard let desktop, !loading else { return }
        loading = true
        remoteGeneration += 1
        let generation = remoteGeneration
        subscription?.cancel()
        isConnected = false
        connectionError = nil
        defer { if remoteGeneration == generation { loading = false } }
        do {
            let bootstrap = try await desktop.bootstrap()
            guard remoteGeneration == generation, !Task.isCancelled else { return }
            guard bootstrap.version == 1 else { throw RemoteFailure("Update both DROIDEX apps to the same remote protocol version.") }
            computerName = bootstrap.computerName
            workspaceName = bootstrap.workspace
            models = bootstrap.models
            replaceRemote(bootstrap.sessions)
            loadState = .ready
            subscription = Task { [weak self] in
                do {
                    for try await event in desktop.updates() {
                        guard let self, self.remoteGeneration == generation, !Task.isCancelled else { return }
                        self.receive(event)
                    }
                    guard let self, self.remoteGeneration == generation, !Task.isCancelled else { return }
                    self.isConnected = false
                    self.connectionError = "The computer connection ended. Reconnect to see the latest state. Work may still be running on your computer."
                } catch {
                    guard let self, self.remoteGeneration == generation, !Task.isCancelled else { return }
                    self.isConnected = false
                    self.connectionError = error.localizedDescription
                }
            }
        } catch {
            guard remoteGeneration == generation, !Task.isCancelled else { return }
            connectionError = error.localizedDescription
            if loadState != .ready { loadState = .failed(error.localizedDescription) }
        }
    }

    private func receive(_ event: RemoteEvent) {
        switch event {
        case .snapshot(let values):
            replaceRemote(values)
            isConnected = true
            connectionError = nil
        case .session(let value): applyRemote(value)
        case .removed(let id):
            sessions.removeAll { $0.id == id }
            remoteRevisions.removeValue(forKey: id)
            knownRemoteIDs.remove(id)
        case .catalog(let values): models = values
        case .heartbeat: break
        }
    }

    private func replaceRemote(_ values: [RemoteSession]) {
        let incoming = Set(values.map(\.id))
        sessions.removeAll { knownRemoteIDs.contains($0.id) && !incoming.contains($0.id) }
        for value in values { applyRemote(value, authoritative: true) }
        knownRemoteIDs = incoming
        remoteRevisions = remoteRevisions.filter { incoming.contains($0.key) }
    }

    private func applyRemote(_ value: RemoteSession, authoritative: Bool = false) {
        if let previous = remoteRevisions[value.id],
           previous > value.revision || (previous == value.revision && !authoritative) { return }
        let existing = session(value.id)
        var replacement = value.localSession(draft: existing?.draft ?? "")
        // Idle diff refreshes must not erase the user's choice for their next turn.
        if let existing, existing.phase.canSend, replacement.phase.canSend {
            replacement.configuration = existing.configuration
        }
        if let index = index(of: value.id) { sessions[index] = replacement }
        else { sessions.insert(replacement, at: 0) }
        knownRemoteIDs.insert(value.id)
        remoteRevisions[value.id] = value.revision
    }

    private func sendRemote(_ text: String, to id: UUID) -> Task<Void, Never>? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let desktop, isConnected, !text.isEmpty, text.count <= Self.promptLimit,
              let index = index(of: id), sessions[index].phase.canSend else { return nil }
        let configuration = sessions[index].configuration
        guard let modelID = configuration.remoteModelID,
              let model = models.first(where: { $0.id == modelID }),
              model.efforts.isEmpty || model.efforts.contains(configuration.remoteEffort ?? "") else {
            connectionError = "Choose a model and effort from your computer's current catalog."
            return nil
        }
        let request = RemoteTurn(id: id, prompt: text, modelId: modelID,
                                 effort: model.efforts.isEmpty ? nil : configuration.remoteEffort,
                                 mode: configuration.interactionMode)
        let pending = UUID()
        sessions[index].phase = .running(pending)
        let generation = remoteGeneration
        return Task { [weak self] in
            do {
                try await desktop.send(request)
                guard let self, self.remoteGeneration == generation, let index = self.index(of: id) else { return }
                if self.sessions[index].draft == text { self.sessions[index].draft = "" }
            } catch {
                guard let self, self.remoteGeneration == generation else { return }
                if let index = self.index(of: id), self.sessions[index].phase == .running(pending) {
                    self.sessions[index].phase = .failed("Delivery was not confirmed. Reconnect before retrying; the computer may already be working.")
                }
                self.isConnected = false
                self.connectionError = error.localizedDescription + " Reconnect before retrying. The message has not been automatically sent again."
            }
        }
    }

    private func performRemote(_ action: @escaping @MainActor () async throws -> Void) {
        guard isConnected else { connectionError = "Reconnect to your computer before taking this action."; return }
        let generation = remoteGeneration
        Task { [weak self] in
            do { try await action() }
            catch {
                guard let self, self.remoteGeneration == generation else { return }
                self.connectionError = error.localizedDescription
            }
        }
    }

}

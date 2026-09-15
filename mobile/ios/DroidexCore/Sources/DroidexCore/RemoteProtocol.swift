import Foundation

public struct RemoteModel: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let efforts: [String]
    public let defaultEffort: String?
}

public struct RemoteQuestion: Codable, Equatable, Identifiable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public let index: Int
        public let question: String
        public let options: [String]
    }
    public let id: UUID
    public let questions: [Item]
}

public struct RemoteSession: Codable, Equatable, Identifiable, Sendable {
    public enum Phase: String, Codable, Sendable {
        case running, approval, question, completed, stopped, failed
    }
    public let id: UUID
    public let runId: UUID
    public let revision: Int
    public let title: String
    public let workspace: String
    public let modelId: String
    public let effort: String?
    public let mode: InteractionMode
    public let phase: Phase
    public let messages: [ChatMessage]
    public let changes: [FileChange]
    public let diffNote: String
    public let approval: Approval?
    public let question: RemoteQuestion?
    public let error: String?
    public let updatedAt: Double

    public func localSession(draft: String = "") -> AgentSession {
        let state: SessionPhase
        switch phase {
        case .running: state = .running(runId)
        case .approval:
            state = approval.map(SessionPhase.needsApproval) ?? .failed("The desktop sent an incomplete approval. Reconnect before continuing.")
        case .question:
            state = question.map(SessionPhase.needsAnswer) ?? .failed("The desktop sent an incomplete question. Reconnect before continuing.")
        case .completed: state = .completed
        case .stopped: state = .stopped
        case .failed: state = .failed(error ?? "The desktop agent could not finish.")
        }
        var configuration = SessionConfiguration(interactionMode: mode)
        configuration.remoteModelID = modelId
        configuration.remoteEffort = effort
        return AgentSession(
            appSessionId: id, title: title, workspace: workspace, configuration: configuration,
            phase: state, messages: messages, changes: changes, draft: draft,
            updatedAt: Date(timeIntervalSince1970: updatedAt / 1_000), diffNote: diffNote
        )
    }
}

public struct RemoteBootstrap: Decodable, Sendable {
    public let version: Int
    public let computerId: UUID
    public let computerName: String
    public let workspace: String
    public let models: [RemoteModel]
    public let sessions: [RemoteSession]
}

public enum RemoteEvent: Decodable, Sendable {
    case snapshot([RemoteSession])
    case session(RemoteSession)
    case removed(UUID)
    case catalog([RemoteModel])
    case heartbeat

    private enum Keys: String, CodingKey { case type, sessions, session, id, models }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "snapshot": self = .snapshot(try values.decode([RemoteSession].self, forKey: .sessions))
        case "session": self = .session(try values.decode(RemoteSession.self, forKey: .session))
        case "removed": self = .removed(try values.decode(UUID.self, forKey: .id))
        case "catalog": self = .catalog(try values.decode([RemoteModel].self, forKey: .models))
        case "heartbeat": self = .heartbeat
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "Unsupported desktop event. Update both apps.")
        }
    }
}

public struct RemoteTurn: Encodable, Sendable {
    public let id: UUID
    public let requestId: UUID
    public let prompt: String
    public let modelId: String
    public let effort: String?
    public let mode: InteractionMode

    public init(id: UUID, requestId: UUID = UUID(), prompt: String, modelId: String, effort: String?, mode: InteractionMode) {
        self.id = id
        self.requestId = requestId
        self.prompt = prompt
        self.modelId = modelId
        self.effort = effort
        self.mode = mode
    }
}

@MainActor
public protocol DesktopService {
    func bootstrap() async throws -> RemoteBootstrap
    func updates() -> AsyncThrowingStream<RemoteEvent, Error>
    func send(_ turn: RemoteTurn) async throws
    func stop(_ id: UUID) async throws
    func approve(_ approvalID: UUID, in sessionID: UUID, allow: Bool) async throws
    func answer(_ questionID: UUID, in sessionID: UUID, answers: [String]) async throws
    func remove(_ id: UUID) async throws
}

public struct RemoteFailure: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

// The pairing code carries the sole trusted address and certificate pin. It is not a URL to open in a browser.
public struct PairingCode: Codable, Equatable, Sendable {
    public let version: Int
    public let address: URL
    public let fingerprint: String
    public let ticket: String

    public static func parse(_ input: String) throws -> PairingCode {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.hasPrefix("DX1."), value.count < 2_048 else {
            throw RemoteFailure("Paste the complete pairing code from DROIDEX on your computer.")
        }
        var encoded = String(value.dropFirst(4)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded) else { throw RemoteFailure("That pairing code is not valid.") }
        let code = try JSONDecoder().decode(PairingCode.self, from: data)
        try code.validate()
        return code
    }

    public func validate() throws {
        let rawParts = address.host?.split(separator: ".") ?? []
        let parts = rawParts.compactMap { UInt8($0) }
        let isPrivate = rawParts.count == 4 && parts.count == 4 && parts.map(String.init).joined(separator: ".") == address.host && (
            parts[0] == 10 || (parts[0] == 192 && parts[1] == 168)
            || (parts[0] == 172 && (16...31).contains(parts[1]))
            || parts == [127, 0, 0, 1]
        )
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        guard version == 1, address.scheme == "https", isPrivate,
              address.user == nil, address.password == nil, address.query == nil, address.fragment == nil,
              address.path.isEmpty || address.path == "/", let port = address.port, (1...65_535).contains(port),
              fingerprint.count == 64, ticket.count == 64,
              fingerprint.unicodeScalars.allSatisfy(hex.contains), ticket.unicodeScalars.allSatisfy(hex.contains) else {
            throw RemoteFailure("This code is not a supported private-network DROIDEX connection.")
        }
    }
}

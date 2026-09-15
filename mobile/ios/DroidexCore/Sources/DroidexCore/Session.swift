import Foundation

public enum Harness: String, Codable, CaseIterable, Sendable {
    case droid = "Droid"
    case claude = "Claude Code"
    case codex = "Codex"
}

public enum ModelChoice: String, Codable, CaseIterable, Sendable {
    case astra = "GPT-6 Astra"
    case fable = "Fable 5.1"
    case fableMax = "Fable 5.1 Max"
    case codex = "GPT-5.6 Codex"

    public static func options(for harness: Harness) -> [ModelChoice] {
        switch harness {
        case .droid: [.astra, .fable, .fableMax, .codex]
        case .claude: [.fable, .fableMax]
        case .codex: [.astra, .codex]
        }
    }
}

public enum ReasoningEffort: Int, Codable, CaseIterable, Sendable {
    case low, medium, high, ultra
    public var title: String { ["Low", "Medium", "High", "Ultra"][rawValue] }
}

public enum InteractionMode: String, Codable, CaseIterable, Sendable {
    case auto, spec

    public var title: String { self == .auto ? "Build" : "Plan" }
}

public struct SessionConfiguration: Codable, Equatable, Sendable {
    public var harness: Harness
    public var model: ModelChoice
    public var reasoning: ReasoningEffort
    public var interactionMode: InteractionMode
    public var remoteModelID: String?
    public var remoteEffort: String?

    public init(harness: Harness = .droid, model: ModelChoice = .astra, reasoning: ReasoningEffort = .high, interactionMode: InteractionMode = .auto) {
        self.harness = harness
        self.model = ModelChoice.options(for: harness).contains(model) ? model : ModelChoice.options(for: harness)[0]
        self.reasoning = reasoning
        self.interactionMode = interactionMode
    }

    private enum CodingKeys: String, CodingKey { case harness, model, reasoning, interactionMode, remoteModelID, remoteEffort }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        harness = try values.decodeIfPresent(Harness.self, forKey: .harness) ?? .droid
        model = try values.decodeIfPresent(ModelChoice.self, forKey: .model) ?? .astra
        reasoning = try values.decodeIfPresent(ReasoningEffort.self, forKey: .reasoning) ?? .high
        interactionMode = try values.decodeIfPresent(InteractionMode.self, forKey: .interactionMode) ?? .auto
        remoteModelID = try values.decodeIfPresent(String.self, forKey: .remoteModelID)
        remoteEffort = try values.decodeIfPresent(String.self, forKey: .remoteEffort)
        if !ModelChoice.options(for: harness).contains(model) { model = ModelChoice.options(for: harness)[0] }
    }
}

public struct Approval: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let title: String
    public let detail: String

    public init(id: UUID = UUID(), title: String, detail: String) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

public enum SessionPhase: Codable, Equatable, Sendable {
    case ready
    case running(UUID)
    case needsApproval(Approval)
    case needsAnswer(RemoteQuestion)
    case completed
    case stopped
    case failed(String)

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    public var approval: Approval? {
        if case .needsApproval(let approval) = self { return approval }
        return nil
    }

    public var question: RemoteQuestion? {
        if case .needsAnswer(let question) = self { return question }
        return nil
    }

    public var canSend: Bool { !isRunning && approval == nil && question == nil }
}

public struct ChatMessage: Codable, Equatable, Sendable, Identifiable {
    public enum Role: String, Codable, Sendable { case user, assistant }

    public let id: UUID
    public let role: Role
    public var text: String
    public var steps: [String]

    public init(id: UUID = UUID(), role: Role, text: String, steps: [String] = []) {
        self.id = id
        self.role = role
        self.text = text
        self.steps = steps
    }
}

public struct DiffLine: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case context, addition, deletion }
    public let kind: Kind
    public let text: String

    public init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }

    public var prefix: String {
        switch kind {
        case .context: " "
        case .addition: "+"
        case .deletion: "−"
        }
    }
}

public struct FileChange: Codable, Equatable, Sendable, Identifiable {
    public let path: String
    public let lines: [DiffLine]
    public var id: String { path }
    public var additions: Int { lines.filter { $0.kind == .addition }.count }
    public var deletions: Int { lines.filter { $0.kind == .deletion }.count }

    public init(path: String, lines: [DiffLine]) {
        self.path = path
        self.lines = lines
    }
}

public struct AgentSession: Codable, Equatable, Sendable, Identifiable {
    public let appSessionId: UUID
    public var title: String
    public let workspace: String
    public var configuration: SessionConfiguration
    public var phase: SessionPhase
    public var messages: [ChatMessage]
    public var changes: [FileChange]
    public var draft: String
    public var updatedAt: Date
    public var diffNote: String?
    public var id: UUID { appSessionId }
    public var additions: Int { changes.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { changes.reduce(0) { $0 + $1.deletions } }

    public init(
        appSessionId: UUID = UUID(), title: String, workspace: String = "droid-maxxing",
        configuration: SessionConfiguration = .init(), phase: SessionPhase = .ready,
        messages: [ChatMessage] = [], changes: [FileChange] = [], draft: String = "",
        updatedAt: Date = .now, diffNote: String? = nil
    ) {
        self.appSessionId = appSessionId
        self.title = title
        self.workspace = workspace
        self.configuration = configuration
        self.phase = phase
        self.messages = messages
        self.changes = changes
        self.draft = draft
        self.updatedAt = updatedAt
        self.diffNote = diffNote
    }
}

public struct TurnRequest: Sendable {
    public let appSessionId: UUID
    public let text: String
    public let configuration: SessionConfiguration
}

public enum AgentEvent: Sendable {
    case step(String)
    case text(String)
    case changes([FileChange])
    case approval(Approval)
    case completed
}

@MainActor
public protocol AgentClient {
    func events(for request: TurnRequest) -> AsyncThrowingStream<AgentEvent, Error>
}

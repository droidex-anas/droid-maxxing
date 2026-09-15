import Foundation

actor SessionArchive {
    private struct Snapshot: Codable {
        let version: Int
        let sessions: [AgentSession]
    }

    enum ArchiveError: LocalizedError {
        case unsupportedVersion, duplicateIdentity

        var errorDescription: String? {
            switch self {
            case .unsupportedVersion: "This session archive uses an unsupported version."
            case .duplicateIdentity: "The session archive contains duplicate session identities."
            }
        }
    }

    private let url: URL
    private var latestRevision = 0

    init(url: URL) { self.url = url }

    func load() throws -> [AgentSession]? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
        guard snapshot.version == 1 else { throw ArchiveError.unsupportedVersion }
        guard Set(snapshot.sessions.map(\.appSessionId)).count == snapshot.sessions.count else {
            throw ArchiveError.duplicateIdentity
        }
        return snapshot.sessions.map { session in
            var restored = session
            // Local preview tasks cannot survive process termination.
            if restored.phase.isRunning {
                restored.phase = .stopped
                restored.messages.append(.init(role: .assistant, text: "The preview was interrupted when the app closed. Send a message to start a new turn."))
            }
            return restored
        }
    }

    func save(_ sessions: [AgentSession], revision: Int) throws {
        guard revision >= latestRevision else { return }
        latestRevision = revision
        let data = try JSONEncoder().encode(Snapshot(version: 1, sessions: sessions))
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}

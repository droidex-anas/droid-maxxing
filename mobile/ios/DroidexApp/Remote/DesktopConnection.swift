import CryptoKit
import DroidexCore
import Foundation
import Security

struct DesktopCredential: Codable, Sendable {
    let code: PairingCode
    let token: String
    let computerId: UUID
    let computerName: String
}

private struct PairReply: Decodable {
    let token: String
    let computerId: UUID
    let computerName: String
}

// Immutable pin and endpoint; URLSession calls these delegate methods off the main actor.
private final class PinnedConnectionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let code: PairingCode
    init(code: PairingCode) { self.code = code }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == code.address.host,
              challenge.protectionSpace.port == code.address.port,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let hash = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()
        guard hash == code.fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class DesktopConnection: DesktopService {
    let credential: DesktopCredential
    private let session: URLSession

    init(credential: DesktopCredential) throws {
        try credential.code.validate()
        guard credential.token.count == 64,
              credential.token.allSatisfy({ "0123456789abcdef".contains($0) }) else {
            throw RemoteFailure("The saved computer credential is invalid. Pair again.")
        }
        self.credential = credential
        session = Self.makeSession(credential.code)
    }

    static func pair(code: PairingCode, name: String) async throws -> DesktopCredential {
        try code.validate()
        let session = makeSession(code)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: code.address.appendingPathComponent("pair"))
        request.httpMethod = "POST"
        request.timeoutInterval = 105
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["ticket": code.ticket, "name": name])
        let (data, response) = try await session.data(for: request)
        try check(response, data: data)
        let reply = try JSONDecoder().decode(PairReply.self, from: data)
        return DesktopCredential(code: code, token: reply.token, computerId: reply.computerId, computerName: reply.computerName)
    }

    func bootstrap() async throws -> RemoteBootstrap {
        let data = try await data(path: "bootstrap")
        let result = try JSONDecoder().decode(RemoteBootstrap.self, from: data)
        guard result.computerId == credential.computerId else {
            throw RemoteFailure("This desktop connection was replaced. Pair with the computer again.")
        }
        return result
    }

    func updates() -> AsyncThrowingStream<RemoteEvent, Error> {
        let request = request(path: "events", timeout: 40)
        let session = session
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(32)) { continuation in
            let task = Task.detached {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    try Self.check(response, data: Data())
                    var line = Data()
                    let decoder = JSONDecoder()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if byte == 10 {
                            if line.isEmpty { continue }
                            let event = try decoder.decode(RemoteEvent.self, from: line)
                            line.removeAll(keepingCapacity: true)
                            switch continuation.yield(event) {
                            case .terminated: return
                            case .dropped:
                                throw RemoteFailure("The phone fell behind the live stream. Reconnect to restore the latest state.")
                            case .enqueued: break
                            @unknown default: break
                            }
                        } else {
                            guard line.count < 8 * 1_024 * 1_024 else {
                                throw RemoteFailure("This conversation is too large for mobile streaming. Review it on the computer.")
                            }
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func send(_ turn: RemoteTurn) async throws {
        _ = try await data(path: "turn", body: JSONEncoder().encode(turn))
    }
    func stop(_ id: UUID) async throws { _ = try await data(path: route(id, "stop"), body: Data("{}".utf8)) }
    func remove(_ id: UUID) async throws { _ = try await data(path: route(id, "remove"), body: Data("{}".utf8)) }
    func approve(_ approvalID: UUID, in sessionID: UUID, allow: Bool) async throws {
        struct Body: Encodable { let id: String; let allow: Bool }
        _ = try await data(path: route(sessionID, "approval"), body: JSONEncoder().encode(Body(id: approvalID.uuidString.lowercased(), allow: allow)))
    }
    func answer(_ questionID: UUID, in sessionID: UUID, answers: [String]) async throws {
        struct Body: Encodable { let id: String; let answers: [String] }
        _ = try await data(path: route(sessionID, "answer"), body: JSONEncoder().encode(Body(id: questionID.uuidString.lowercased(), answers: answers)))
    }

    private func route(_ id: UUID, _ operation: String) -> String { "sessions/\(id.uuidString.lowercased())/\(operation)" }

    private func request(path: String, timeout: TimeInterval = 30) -> URLRequest {
        var request = URLRequest(url: credential.code.address.appendingPathComponent(path))
        request.timeoutInterval = timeout
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func data(path: String, body: Data? = nil) async throws -> Data {
        var request = request(path: path)
        request.httpBody = body
        request.httpMethod = body == nil ? "GET" : "POST"
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data: data)
        guard data.count <= 16 * 1_024 * 1_024 else { throw RemoteFailure("Desktop response exceeded the mobile size limit.") }
        return data
    }

    nonisolated private static func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw RemoteFailure("The computer sent an invalid response.") }
        guard (200...299).contains(http.statusCode) else {
            struct Failure: Decodable { let error: String }
            let detail = (try? JSONDecoder().decode(Failure.self, from: data))?.error
            throw RemoteFailure(detail ?? "The computer refused the connection (\(http.statusCode)). Reconnect or pair again.")
        }
    }

    private static func makeSession(_ code: PairingCode) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: PinnedConnectionDelegate(code: code), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }
}

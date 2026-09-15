import Foundation

@MainActor
public struct DemoAgentClient: AgentClient {
    public init() {}

    public func events(for request: TurnRequest) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { continuation in
            let producer = Task {
                do {
                    for step in ["Open sample workspace", "Inspect sample composer", "Prepare an illustrative patch"] {
                        try await Task.sleep(for: .milliseconds(350))
                        continuation.yield(.step(step))
                    }
                    let response: String
                    if request.configuration.interactionMode == .spec {
                        response = "Your request is saved. This is a scripted Plan preview, not a live model response.\n\nFor the sample composer, keep one clear input surface, place secondary choices behind a menu, and reserve feedback for meaningful actions. Review the sample patch before moving to implementation."
                    } else {
                        response = "Your request is saved. This is a scripted \(request.configuration.harness.rawValue) preview, not a live model response.\n\nThe sample change keeps the composer quiet and adds one light haptic when a message is sent. The illustrative diff is ready to inspect. No repository files have been read or changed."
                    }
                    for word in response.split(separator: " ", omittingEmptySubsequences: false) {
                        try await Task.sleep(for: .milliseconds(45))
                        continuation.yield(.text(String(word) + " "))
                    }
                    continuation.yield(.changes(DemoContent.changes))
                    if request.configuration.interactionMode == .auto {
                        continuation.yield(.approval(DemoContent.approval()))
                    } else {
                        continuation.yield(.completed)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in producer.cancel() }
        }
    }
}

public enum DemoContent {
    public static let changes: [FileChange] = [
        FileChange(path: "Example/Composer.swift", lines: [
            .init(.context, "Button(action: send) {"),
            .init(.context, "    Image(systemName: \"arrow.up\")"),
            .init(.context, "}"),
            .init(.deletion, ".padding(8)"),
            .init(.addition, ".frame(minWidth: 44, minHeight: 44)"),
            .init(.addition, ".accessibilityLabel(\"Send message\")"),
            .init(.addition, ".sensoryFeedback(.selection, trigger: sentCount)")
        ]),
        FileChange(path: "Example/Conversation.swift", lines: [
            .init(.context, "ScrollView {"),
            .init(.context, "    conversation"),
            .init(.context, "}"),
            .init(.addition, ".scrollDismissesKeyboard(.interactively)"),
            .init(.addition, ".safeAreaInset(edge: .bottom) { composer }")
        ])
    ]

    public static func approval() -> Approval {
        Approval(
            title: "Approve the sample patch?",
            detail: "This exercises the permission flow only. Approval does not execute a command or modify your repository."
        )
    }

    public static func sessions(now: Date = .now) -> [AgentSession] {
        [
            AgentSession(
                title: "Refine the mobile composer", phase: .needsApproval(approval()),
                messages: [
                    .init(role: .user, text: "Make the composer feel native. Quiet, clear, and easy to use with one hand."),
                    .init(role: .assistant,
                          text: "One floating input. Secondary controls stay out of the way. A light haptic confirms a deliberate action, never each streamed word.\n\nThere are two illustrative files to review. This is sample content, not a real repository change.",
                          steps: ["Inspect sample layout", "Check sample touch targets", "Prepare illustrative diff"])
                ], changes: changes, updatedAt: now.addingTimeInterval(-180)
            ),
            AgentSession(
                title: "Review session cleanup", configuration: .init(harness: .codex, interactionMode: .spec),
                phase: .completed,
                messages: [
                    .init(role: .user, text: "What should happen when I stop a session?"),
                    .init(role: .assistant, text: "Invalidate the active run before cancelling its task. A late event must never write into a replacement run or a different session.\n\nThis sample conversation shows the reading layout. Start a new message to try simulated streaming and cancellation.")
                ], updatedAt: now.addingTimeInterval(-3600)
            ),
            AgentSession(title: "Explore the design workspace", updatedAt: now.addingTimeInterval(-7200))
        ]
    }
}

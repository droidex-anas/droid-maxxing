import DroidexCore
import SwiftUI

struct ConversationView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    let sessionID: UUID
    @State private var showReview = false
    @State private var renaming = false
    @State private var title = ""
    @State private var deleting = false
    @State private var isAtBottom = true
    private let bottomID = "conversation-bottom"

    var body: some View {
        if let session = store.session(sessionID) {
            conversation(session)
                .background(DroidTheme.background)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 2) {
                            Text(session.title).font(.headline).lineLimit(1)
                            Text("\(store.modelName(session.configuration)) · \(store.effortName(session.configuration))")
                                .font(.caption2).foregroundStyle(DroidTheme.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            if !store.isRemote {
                                Button("Rename", systemImage: "pencil") { title = session.title; renaming = true }
                            }
                            ShareLink(item: exportedConversation(session)) { Label("Share conversation", systemImage: "square.and.arrow.up") }
                            Button(store.isRemote ? "Close remote session" : "Delete session", systemImage: "trash", role: .destructive) { deleting = true }
                        } label: { Label("Session actions", systemImage: "ellipsis") }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ComposerView(
                        text: Binding(get: { store.session(sessionID)?.draft ?? "" }, set: { store.setDraft($0, for: sessionID) }),
                        configuration: Binding(get: { store.session(sessionID)?.configuration ?? .init() }, set: { store.configure(sessionID, with: $0) }),
                        phase: session.phase,
                        send: { store.send(store.session(sessionID)?.draft ?? "", to: sessionID) },
                        stop: { store.stop(sessionID) }
                    )
                    .frame(maxWidth: 720)
                    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
                    .frame(maxWidth: .infinity)
                }
                .sensoryFeedback(trigger: session.phase) { _, phase in
                    guard hapticsEnabled, scenePhase == .active else { return nil }
                    switch phase {
                    case .running: return .impact(weight: .light, intensity: 0.6)
                    case .needsApproval, .needsAnswer: return .warning
                    case .completed: return .success
                    case .failed: return .error
                    case .stopped: return .selection
                    case .ready: return nil
                    }
                }
                .sheet(isPresented: $showReview) { ReviewView(sessionID: sessionID) }
                .alert("Rename session", isPresented: $renaming) {
                    TextField("Title", text: $title)
                    Button("Cancel", role: .cancel) {}
                    Button("Save") { store.rename(sessionID, to: title) }
                }
                .confirmationDialog(store.isRemote ? "Close this session on your computer?" : "Delete this local session?", isPresented: $deleting, titleVisibility: .visible) {
                    Button(store.isRemote ? "Close remote session" : "Delete session", role: .destructive) { store.delete(sessionID) }
                } message: {
                    Text(store.isRemote ? "Running work will stop. Edits already made are not undone. Desktop history is retained." : "This removes the local preview conversation.")
                }
        } else {
            ContentUnavailableView("Session removed", systemImage: "tray")
        }
    }

    private func conversation(_ session: AgentSession) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if session.messages.isEmpty && !session.phase.isRunning {
                        ContentUnavailableView {
                            Label("A fresh session", systemImage: "text.bubble")
                        } description: {
                            Text(store.isRemote ? "Describe what to build, review, or explore on your computer." : "Describe what to build, review, or explore. Responses in preview mode are scripted.")
                        }
                        .frame(maxWidth: .infinity).padding(.top, 56)
                    }
                    ForEach(session.messages) { message in
                        MessageRow(message: message, isRunning: session.phase.isRunning && message.id == session.messages.last?.id)
                    }
                    if session.phase.isRunning, session.messages.last?.steps.isEmpty != false {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("Starting \(store.modelName(session.configuration))…").font(.footnote)
                        }
                        .foregroundStyle(DroidTheme.secondary)
                    } else if !session.phase.isRunning {
                        PhaseLabel(phase: session.phase)
                    }
                    if case .failed(let error) = session.phase {
                        Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(DroidTheme.danger)
                    }
                    if !session.changes.isEmpty { changesButton(session) }
                    else if let note = session.diffNote, !note.isEmpty {
                        Text(note).font(.footnote).foregroundStyle(DroidTheme.secondary)
                    }
                    if let approval = session.phase.approval {
                        ApprovalCard(approval: approval) { allow in store.respond(to: approval.id, in: sessionID, allow: allow) }
                    }
                    if let question = session.phase.question {
                        QuestionCard(question: question, sessionID: sessionID).id(question.id)
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                .frame(maxWidth: 680)
                .padding(.horizontal, 22).padding(.vertical, 24)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 80
            } action: { _, value in isAtBottom = value }
            .onChange(of: session.messages.last?.text) { _, _ in if isAtBottom { proxy.scrollTo(bottomID, anchor: .bottom) } }
            .onChange(of: session.messages.count) { _, _ in if isAtBottom { proxy.scrollTo(bottomID, anchor: .bottom) } }
            .onChange(of: session.phase) { _, _ in if isAtBottom { proxy.scrollTo(bottomID, anchor: .bottom) } }
            .overlay(alignment: .bottomTrailing) {
                if !isAtBottom {
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down").font(.body.weight(.semibold)).frame(width: 44, height: 44)
                            .modifier(GlassChrome(cornerRadius: 22, interactive: true))
                    }
                    .buttonStyle(.plain).accessibilityLabel("Jump to latest message").padding(16)
                }
            }
        }
    }

    private func changesButton(_ session: AgentSession) -> some View {
        Button { showReview = true } label: {
            VStack(alignment: .leading, spacing: 10) {
                Label("Review changes", systemImage: "doc.text").font(.subheadline.weight(.medium))
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        Text("\(session.changes.count) \(store.isRemote ? "working-tree files" : "illustrative files")")
                        Spacer(minLength: 4)
                        DiffCounts(additions: session.additions, deletions: session.deletions)
                        Image(systemName: "chevron.right")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(session.changes.count) \(store.isRemote ? "working-tree files" : "illustrative files")")
                        DiffCounts(additions: session.additions, deletions: session.deletions)
                    }
                }
                .font(.caption).foregroundStyle(DroidTheme.secondary)
            }
            .padding(16).background(DroidTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain).accessibilityIdentifier("review.open")
    }

    private func exportedConversation(_ session: AgentSession) -> String {
        "DROIDEX · \(store.isRemote ? "Remote session" : "Local preview")\n\(session.title)\n\n" + session.messages.map { "\($0.role == .user ? "You" : "DROIDEX")\n\($0.text)" }.joined(separator: "\n\n")
    }
}

private struct MessageRow: View {
    let message: ChatMessage
    let isRunning: Bool

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 32)
                Text(message.text)
                    .font(.body).textSelection(.enabled)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(DroidTheme.elevated, in: RoundedRectangle(cornerRadius: 22))
            }
            .accessibilityLabel("You: \(message.text)")
        } else {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 7) {
                    Text("DROIDEX").font(.caption2.weight(.semibold)).tracking(1.5)
                    if isRunning { Circle().fill(DroidTheme.text).frame(width: 4, height: 4) }
                }
                .foregroundStyle(DroidTheme.secondary)
                if !message.steps.isEmpty { AgentStepsView(steps: message.steps, isRunning: isRunning) }
                if !message.text.isEmpty {
                    Text(message.text).font(.body).lineSpacing(5).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

import DroidexCore
import SwiftUI

private enum InboxFilter: String, CaseIterable, Identifiable {
    case all = "All sessions", attention = "Needs you", working = "Working", ready = "Ready"
    var id: Self { self }

    var symbol: String {
        switch self {
        case .all: "square.stack.3d.up"
        case .attention: "hand.raised"
        case .working: "circle.dotted.circle"
        case .ready: "checkmark.circle"
        }
    }

    func contains(_ session: AgentSession) -> Bool {
        switch self {
        case .all: true
        case .attention:
            if case .failed = session.phase { true } else { session.phase.approval != nil || session.phase.question != nil }
        case .working: session.phase.isRunning
        case .ready: session.phase == .completed
        }
    }
}

struct InboxView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicType
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @Binding var selection: UUID?
    @State private var filter: InboxFilter = .all
    @State private var search = ""
    @State private var newSession = false
    @State private var settings = false
    @State private var deletingSession: AgentSession?
    @State private var confirmDelete = false

    private var visibleSessions: [AgentSession] {
        store.sessions.filter { session in
            filter.contains(session) && (search.isEmpty || session.title.localizedCaseInsensitiveContains(search)
                || session.messages.contains { $0.text.localizedCaseInsensitiveContains(search) })
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        List(selection: $selection) {
            Section {
                VStack(alignment: .leading, spacing: 16) {
                    Text(store.isRemote ? (store.isConnected ? "CONNECTED · " + store.computerName : "COMPUTER DISCONNECTED") : "LOCAL PREVIEW")
                        .font(.caption2.weight(.semibold))
                        .tracking(1.8)
                        .foregroundStyle(DroidTheme.secondary)
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(InboxFilter.allCases) { option in
                            filterTile(option)
                        }
                    }
                }
                .padding(.vertical, 10)
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)

            Section {
                if visibleSessions.isEmpty {
                    ContentUnavailableView {
                        Label(search.isEmpty ? "No sessions here" : "No matching sessions", systemImage: "tray")
                    } description: {
                        Text(search.isEmpty ? "Try another filter or start a session." : "Search by title or something in the conversation.")
                    } actions: {
                        Button("Show all sessions") { filter = .all; search = "" }
                    }
                    .listRowBackground(Color.clear)
                }
                ForEach(visibleSessions) { session in
                    NavigationLink(value: session.appSessionId) {
                        SessionRow(session: session)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparatorTint(DroidTheme.separator)
                    .swipeActions(edge: .trailing) {
                        Button(store.isRemote ? "Close" : "Delete", role: .destructive) {
                            deletingSession = session
                            confirmDelete = true
                        }
                    }
                }
            } header: {
                HStack {
                    Label(store.workspaceName, systemImage: "folder")
                    Spacer()
                    Text("\(visibleSessions.count)").monospacedDigit()
                }
                .textCase(nil)
                .font(.subheadline)
                .foregroundStyle(DroidTheme.secondary)
                .padding(.vertical, 8)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(DroidTheme.background)
        .searchable(text: $search, prompt: "Search sessions")
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                BrandMark().frame(width: 92, height: 14)
                Spacer()
                Button { settings = true } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.body.weight(.medium))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 5)
            .background(DroidTheme.background.opacity(0.96))
        }
        .safeAreaInset(edge: .bottom) {
            Button { newSession = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus").font(.body.weight(.medium))
                    Text("Plan, ask, build…").foregroundStyle(DroidTheme.secondary)
                    Spacer(minLength: 0)
                    Image(systemName: "square.and.pencil")
                }
                .font(.body)
                .padding(.horizontal, 18)
                .frame(minHeight: 56)
                .modifier(GlassChrome(interactive: true))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New session")
            .accessibilityIdentifier("inbox.compose")
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .sensoryFeedback(.selection, trigger: filter) { _, _ in hapticsEnabled }
        .sensoryFeedback(.selection, trigger: selection) { _, value in hapticsEnabled && value != nil }
        .sheet(isPresented: $newSession) {
            NewSessionView { selection = $0 }
        }
        .sheet(isPresented: $settings) {
            SettingsView { selection = nil }
        }
        .confirmationDialog(store.isRemote ? "Close this session on your computer?" : "Delete this local session?", isPresented: $confirmDelete, titleVisibility: .visible, presenting: deletingSession) { session in
            Button(store.isRemote ? "Close remote session" : "Delete session", role: .destructive) { store.delete(session.appSessionId) }
        } message: { session in
            Text(store.isRemote ? "Running work will stop. Edits are not undone, and desktop history is retained." : "“\(session.title)” will be removed from this device. Your repository is not affected.")
        }
    }

    private var columns: [GridItem] {
        dynamicType.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 142), spacing: 10)]
    }

    private func filterTile(_ option: InboxFilter) -> some View {
        Button { filter = option } label: {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Image(systemName: option.symbol).font(.body)
                        .foregroundStyle(option == .attention ? DroidTheme.warning : DroidTheme.secondary)
                    Spacer()
                    Text("\(store.sessions.filter { option.contains($0) }.count)")
                        .font(.title3.weight(.medium)).monospacedDigit()
                }
                Text(option.rawValue).font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(filter == option ? DroidTheme.elevated : DroidTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(filter == option ? DroidTheme.separator : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(filter == option ? .isSelected : [])
    }
}

private struct SessionRow: View {
    let session: AgentSession

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(session.title)
                .font(.body.weight(.medium))
                .lineLimit(2)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    PhaseLabel(phase: session.phase)
                    Spacer(minLength: 0)
                    trailingDetail
                }
                VStack(alignment: .leading, spacing: 6) {
                    PhaseLabel(phase: session.phase)
                    trailingDetail
                }
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var trailingDetail: some View {
        if session.changes.isEmpty {
            Text(session.updatedAt, style: .relative).font(.caption).foregroundStyle(DroidTheme.secondary)
        } else {
            DiffCounts(additions: session.additions, deletions: session.deletions)
        }
    }
}

import DroidexCore
import SwiftUI

@main
struct DroidexApp: App {
    @State private var connection = AppConnection()
    @AppStorage("appearance") private var appearance = "system"

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = connection.store {
                    AppRoot().environment(store).id(ObjectIdentifier(store))
                } else {
                    OnboardingView()
                }
            }
            .environment(connection)
            .tint(DroidTheme.text)
            .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
            .task { connection.restore() }
        }
    }
}

struct AppRoot: View {
    @Environment(SessionStore.self) private var store
    @Environment(AppConnection.self) private var connection
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: UUID?
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var resetting = false

    var body: some View {
        Group {
            switch store.loadState {
            case .loading:
                ProgressView("Opening DROIDEX")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label(store.isRemote ? "Computer unavailable" : "Can't open saved sessions", systemImage: "externaldrive.badge.exclamationmark")
                } description: {
                    Text(store.isRemote ? message : message + " Your existing file has not been replaced.")
                } actions: {
                    Button("Try again") { Task { await store.load() } }
                    if store.isRemote {
                        Button("Pair a computer again") { Task { await connection.forget() } }
                    } else {
                        Button("Reset local preview", role: .destructive) { resetting = true }
                    }
                }
            case .ready:
                NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
                    InboxView(selection: $selection)
                        .navigationSplitViewColumnWidth(min: 290, ideal: 350, max: 430)
                } detail: {
                    if let selection, store.session(selection) != nil {
                        ConversationView(sessionID: selection)
                            .id(selection)
                    } else {
                        ContentUnavailableView {
                            BrandMark().frame(width: 148, height: 20)
                        } description: {
                            Text("Select a session, or start something new.")
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(DroidTheme.background)
                    }
                }
                .navigationSplitViewStyle(.balanced)
                .onChange(of: selection) { _, value in
                    compactColumn = value == nil ? .sidebar : .detail
                }
                .onChange(of: store.sessions.map(\.appSessionId)) { _, ids in
                    if let selected = selection, !ids.contains(selected) { selection = nil }
                }
            }
        }
        .foregroundStyle(DroidTheme.text)
        .background(DroidTheme.background)
        .safeAreaInset(edge: .top, spacing: 0) {
            if store.isRemote, store.loadState == .ready, !store.isConnected || store.connectionError != nil {
                Button { Task { await store.reconnect() } } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.isConnected ? "Connection needs attention" : "Computer disconnected").fontWeight(.medium)
                        Text((store.connectionError ?? "Reconnect to restore live progress. Work continues on your computer.") + " Tap to reconnect.")
                    }
                    .font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12).background(DroidTheme.surface)
                }.buttonStyle(.plain).foregroundStyle(DroidTheme.warning)
            }
            if let error = store.storageError {
                Button {
                    Task { await store.flush() }
                } label: {
                    Label(error + " Tap to retry.", systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(DroidTheme.surface)
                }
                .buttonStyle(.plain)
                .foregroundStyle(DroidTheme.warning)
            }
        }
        .task { await store.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { Task { await store.suspend() } }
            else if phase == .active, store.isRemote { Task { await store.load() } }
        }
        .confirmationDialog("Replace the saved preview conversations?", isPresented: $resetting, titleVisibility: .visible) {
            Button("Reset local preview", role: .destructive) {
                Task { await store.resetPreview() }
            }
        }
    }
}

#Preview("Dark · iPhone") {
    AppRoot().environment(SessionStore()).environment(AppConnection()).preferredColorScheme(.dark)
}

#Preview("Light · large text") {
    AppRoot().environment(SessionStore()).environment(AppConnection())
        .preferredColorScheme(.light)
        .environment(\.dynamicTypeSize, .accessibility2)
}

import DroidexCore
import SwiftUI

struct ReviewView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    let sessionID: UUID
    @State private var expanded: Set<String> = []

    var body: some View {
        NavigationStack {
            if let session = store.session(sessionID) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("A closer look.").font(.title.weight(.semibold))
                            Text(store.isRemote ? (session.diffNote ?? "Working-tree changes from your computer.") : "This is a bundled sample patch, not a diff fetched from your repository.")
                                .font(.callout).foregroundStyle(DroidTheme.secondary)
                            HStack {
                                Text("\(session.changes.count) files").font(.subheadline)
                                Spacer()
                                DiffCounts(additions: session.additions, deletions: session.deletions)
                            }
                        }
                        ForEach(session.changes) { change in
                            DisclosureGroup(isExpanded: Binding(
                                get: { expanded.contains(change.path) },
                                set: { if $0 { expanded.insert(change.path) } else { expanded.remove(change.path) } }
                            )) {
                                DiffContent(change: change).padding(.top, 12)
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(change.path).font(.subheadline.weight(.medium))
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                    DiffCounts(additions: change.additions, deletions: change.deletions)
                                }
                                .padding(.vertical, 8)
                            }
                            .padding(14)
                            .background(DroidTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }
                        if let approval = session.phase.approval {
                            ApprovalCard(approval: approval) { allow in
                                store.respond(to: approval.id, in: sessionID, allow: allow)
                            }
                        } else {
                            PhaseLabel(phase: session.phase)
                        }
                    }
                    .frame(maxWidth: 760)
                    .padding(20)
                    .frame(maxWidth: .infinity)
                }
                .background(DroidTheme.background)
                .navigationTitle("Changes")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: exportPatch(session.changes)) {
                            Label(store.isRemote ? "Share working-tree review" : "Share sample patch", systemImage: "square.and.arrow.up")
                        }
                    }
                }
                .onAppear { expanded = Set(session.changes.map(\.path)) }
                .sensoryFeedback(.selection, trigger: expanded) { _, _ in hapticsEnabled }
            } else {
                ContentUnavailableView("Session removed", systemImage: "tray")
                    .toolbar { Button("Done") { dismiss() } }
            }
        }
    }

    private func exportPatch(_ changes: [FileChange]) -> String {
        (store.isRemote ? "DROIDEX working-tree review. May include existing edits. This is a readable excerpt, not an apply-ready patch.\n\n" : "DROIDEX illustrative patch. Not an actual repository diff.\n\n") + changes.map { change in
            change.path + "\n" + change.lines.map { $0.prefix + $0.text }.joined(separator: "\n")
        }.joined(separator: "\n\n")
    }
}

private struct DiffContent: View {
    let change: FileChange

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(change.lines.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(line.prefix).frame(width: 12)
                        Text(line.text.isEmpty ? " " : line.text).textSelection(.enabled)
                    }
                    .font(.system(.caption, design: .monospaced))
                    .padding(.vertical, 5)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(line.kind == .context ? DroidTheme.text : line.kind == .addition ? DroidTheme.success : DroidTheme.danger)
                    .background(line.kind == .context ? Color.clear : line.kind == .addition ? DroidTheme.success.opacity(0.09) : DroidTheme.danger.opacity(0.09))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(line.kind.rawValue): \(line.text)")
                }
            }
            .fixedSize(horizontal: true, vertical: false)
        }
        .accessibilityLabel("Code diff. Scroll horizontally for long lines.")
    }
}

struct ApprovalCard: View {
    @Environment(SessionStore.self) private var store
    let approval: Approval
    let respond: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(approval.title, systemImage: "hand.raised")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(DroidTheme.warning)
            Text(approval.detail).textSelection(.enabled).font(.callout).foregroundStyle(DroidTheme.secondary)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { decline; approve }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 10) { approve; decline }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DroidTheme.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(DroidTheme.warning.opacity(0.25)))
        .disabled(!store.canSend)
    }

    private var decline: some View {
        Button("Decline") { respond(false) }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityIdentifier("approval.decline")
    }

    private var approve: some View {
        Button(store.isRemote ? "Approve once" : "Approve preview") { respond(true) }
            .buttonStyle(.borderedProminent)
            .tint(DroidTheme.text)
            .foregroundStyle(DroidTheme.background)
            .controlSize(.large)
            .accessibilityIdentifier("approval.allow")
    }
}

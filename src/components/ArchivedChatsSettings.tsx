import { useState } from 'react';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { archivedChats, chatDisplayTitle } from '../lib/chatMetadata';
import { formatRelativeTime } from '../lib/time';
import { workspaceName } from '../lib/workspaces';

// Settings > Archived chats: chats hidden from the sidebar live here. Restore
// brings a chat back to the normal list; delete removes it from the app
// permanently. Both are app-level metadata only — the underlying conversation
// data is never touched.
export function ArchivedChatsSettings() {
  const dispatch = useStoreDispatch();
  const { sessionOrder, sessions, chatMetadata } = useStoreSelector(
    (state) => ({
      sessionOrder: state.sessionOrder,
      sessions: state.sessions,
      chatMetadata: state.chatMetadata,
    }),
    shallowEqual,
  );
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const rows = archivedChats(sessionOrder.map((id) => sessions[id]).filter(Boolean), chatMetadata);
  const now = Date.now();

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-4">
        <h2 className="text-[15px] font-semibold text-droid-text">Archived chats</h2>
        <p className="text-[12px] text-droid-text-muted mt-0.5">
          Hidden from your sidebar. Restore a chat to bring it back, or delete it for good.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-droid-border bg-droid-surface/40 p-10 text-center">
          <p className="text-[13px] text-droid-text-secondary">No archived chats.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-droid-border bg-droid-surface/40 divide-y divide-droid-border overflow-hidden">
          {rows.map(({ session, archivedAt }) => {
            const title = chatDisplayTitle(session, chatMetadata[session.appSessionId]);
            return (
              <div
                key={session.appSessionId}
                data-testid="archived-chat-row"
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-droid-text">{title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">
                    Archived {formatRelativeTime(archivedAt, now)}
                    {session.cwd ? ` · ${workspaceName(session.cwd)}` : ''}
                  </div>
                </div>
                {confirmingDelete === session.appSessionId ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span aria-live="polite" className="text-[11px] text-red-400">
                      Delete permanently?
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        dispatch({ type: 'DELETE_CHAT', appSessionId: session.appSessionId });
                        setConfirmingDelete(null);
                      }}
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-red-300 bg-red-500/15 transition-colors hover:bg-red-500/25"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      // The trash button unmounts when the confirm opens, so
                      // focus the safe action to keep keyboard users in place.
                      autoFocus
                      onClick={() => {
                        setConfirmingDelete(null);
                      }}
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title="Restore to sidebar"
                      aria-label={`Restore ${title}`}
                      onClick={() => {
                        dispatch({ type: 'RESTORE_CHAT', appSessionId: session.appSessionId });
                      }}
                      className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
                    >
                      <ArchiveRestore className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      title="Delete permanently"
                      aria-label={`Delete ${title} permanently`}
                      onClick={() => {
                        setConfirmingDelete(session.appSessionId);
                      }}
                      className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useStoreDispatch } from './useStore';
import { chatDisplayTitle, isChatHidden, type ChatMetadataMap } from '../lib/chatMetadata';
import { exportSessionMarkdown, renameSession } from '../lib/commands';
import { toast } from '../lib/toast';
import type { SessionSummary } from '../types/bridge';

// "Copy as Markdown" flow: the sidecar renders the full transcript from the
// stored session file (works for chats never opened this run); here we only
// move the result onto the clipboard and report via toast.
function copyChatAsMarkdown(appSessionId: string, title: string): void {
  exportSessionMarkdown(appSessionId, title)
    .then((markdown) => navigator.clipboard.writeText(markdown))
    .then(() => toast.success('Chat copied as Markdown.'))
    .catch((error: unknown) => {
      // Version-skew rejections were already toasted by the global bridge
      // subscriber; showing the same message again would double-notify.
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'bridge.unsupported_command'
      ) {
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not export this chat.');
    });
}

// Nullable on purpose: the menu's target session can vanish between the click
// and render (archive from another surface); a cleanup effect in the component
// closes the menu a frame later.
export function rowMenuTarget(
  sessions: Record<string, SessionSummary>,
  rowMenu: { appSessionId: string } | null,
  metadata: ChatMetadataMap,
): SessionSummary | null {
  if (
    !rowMenu ||
    !Object.hasOwn(sessions, rowMenu.appSessionId) ||
    isChatHidden(metadata[rowMenu.appSessionId])
  )
    return null;
  return sessions[rowMenu.appSessionId];
}

// Owns chat action targeting, inline rename settlement, and stale-target cleanup.
export function useSidebarRowActions(
  sessions: Record<string, SessionSummary>,
  chatMetadata: ChatMetadataMap,
) {
  const dispatch = useStoreDispatch();
  // Target of the chat row action menu (opened by right-click or the hover
  // "..." button) and the row currently being renamed inline.
  const [rowMenu, setRowMenu] = useState<{ appSessionId: string; x: number; y: number } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const handleRowMenu = useCallback((appSessionId: string, position: { x: number; y: number }) => {
    setRowMenu({ appSessionId, x: position.x, y: position.y });
  }, []);

  // Stable identity so SessionContextMenu's escape-layer/listener effect does
  // not re-register on every sidebar render.
  const closeRowMenu = useCallback(() => {
    setRowMenu(null);
  }, []);

  // If the menu's (or rename editor's) target chat disappears mid-interaction
  // — archived from another surface or pruned by a session-list update —
  // close the UI instead of acting on a ghost.
  useEffect(() => {
    if (rowMenu) {
      const gone =
        !Object.hasOwn(sessions, rowMenu.appSessionId) ||
        isChatHidden(chatMetadata[rowMenu.appSessionId]);
      if (gone) setRowMenu(null);
    }
    if (renamingId) {
      const gone = !Object.hasOwn(sessions, renamingId) || isChatHidden(chatMetadata[renamingId]);
      if (gone) setRenamingId(null);
    }
  }, [rowMenu, renamingId, sessions, chatMetadata]);

  // The stored displayTitle is the UI source of truth; the native harness
  // rename is a best-effort sync so other clients see the new title too. A
  // blank title means "revert to the generated title" and stays local-only.
  const handleRenameCommit = useCallback(
    (appSessionId: string, title: string) => {
      setRenamingId(null);
      dispatch({ type: 'RENAME_CHAT', appSessionId, title });
      const trimmed = title.trim();
      if (trimmed) renameSession(appSessionId, trimmed);
    },
    [dispatch],
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingId(null);
  }, []);

  const rowMenuSession = rowMenuTarget(sessions, rowMenu, chatMetadata);

  const handleCopyMarkdown = useCallback(
    (appSessionId: string) => {
      if (!Object.hasOwn(sessions, appSessionId)) return;
      const session = sessions[appSessionId];
      copyChatAsMarkdown(appSessionId, chatDisplayTitle(session, chatMetadata[appSessionId]));
    },
    [sessions, chatMetadata],
  );

  return {
    rowMenu: rowMenuSession ? rowMenu : null,
    renamingId,
    rowMenuSession,
    handleRowMenu,
    closeRowMenu,
    handleRenameCommit,
    handleRenameCancel,
    handleCopyMarkdown,
    startRenaming: setRenamingId,
  };
}

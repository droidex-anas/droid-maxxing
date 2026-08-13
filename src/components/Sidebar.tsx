// File-size exception (AGENTS.md): this file is the sidebar's single
// composition root — brand header, tool buttons, workspace/chat/pinned section
// wiring, unread/search chrome, update prompt, and the row menu/rename glue
// handlers. ~650 lines. The interactive row (SessionRow, marquee, inline
// rename) already lives in SidebarSessionRow.tsx; further splitting was
// rejected because the remaining handlers are composition glue that fail the
// deletion test (extracting them would only forward store state), and the
// Expand/WorkspaceFolderIcon primitives are too small to justify their own
// modules. Reviewed ceiling: ~700 lines; extract the workspace section if it
// grows past that.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { useDocumentVisible } from '../hooks/useDocumentVisible';
import { pickDirectory } from '../lib/desktop';
import { dismissSidebarCard, loadSidebarCardSeen } from '../lib/sidebarCards';
import { SIDEBAR_WELCOME_CARD_ID, SidebarWelcomeCard } from './SidebarWelcomeCard';
import { BrandMark } from './BrandMark';
import SidebarSearch from './SidebarSearch';
import {
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings,
  ChevronRight,
  Download,
  Loader2,
  SquarePen,
} from 'lucide-react';
import { UnreadFilterActions } from './UnreadFilterActions';
import {
  buildWorkspaceSections,
  resolveNewChatCwd,
  SIDEBAR_VISIBLE_SESSION_LIMIT,
  type WorkspaceScope,
} from '../lib/workspaces';
import { chatDisplayTitle, isChatHidden, isChatPinned, pinnedChats } from '../lib/chatMetadata';
import { exportSessionMarkdown, renameSession } from '../lib/commands';
import { toast } from '../lib/toast';
import { SessionContextMenu } from './SessionContextMenu';
import { SessionRow } from './SidebarSessionRow';
import { sessionIsLive, sessionIsUnread } from '../lib/sessions';
import { sessionAttention } from '../lib/sessionAttention';
import { useAppUpdate } from '../lib/appUpdate';
import type { SessionSummary } from '../types/bridge';

// Blue download glyph docked beside Settings when a newer DROIDEX build is
// available; spins while the artifact is on its way.
function UpdateButton() {
  const { update, downloading, start } = useAppUpdate();
  if (!update?.updateAvailable) return null;
  const actionLabel = `Review DROIDEX ${update.latest} update`;
  return (
    <button
      onClick={() => {
        void start();
      }}
      disabled={downloading}
      title={actionLabel}
      aria-label={actionLabel}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-blue-500 transition-colors hover:bg-droid-elevated disabled:opacity-60"
    >
      {downloading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Download className="w-4 h-4" />
      )}
    </button>
  );
}

const EASE = [0.16, 1, 0.3, 1] as const;

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
function rowMenuTarget(
  sessions: Record<string, SessionSummary>,
  rowMenu: { appSessionId: string } | null,
): SessionSummary | null {
  if (!rowMenu || !Object.hasOwn(sessions, rowMenu.appSessionId)) return null;
  return sessions[rowMenu.appSessionId];
}

// Animated expand/collapse for sidebar sections, no chrome. Reduced-motion
// users get an instantaneous toggle (zero-duration transitions, same pattern
// as SubagentsDock).
function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// The workspace folder glyph doubles as the collapse indicator: closed while
// the workspace is collapsed, open while expanded, crossfading between states.
function WorkspaceFolderIcon({ open }: { open: boolean }) {
  const reduceMotion = useReducedMotion();
  const duration = reduceMotion ? 0 : 0.15;
  return (
    <span className="relative block w-4 h-4 shrink-0 text-droid-text-muted">
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        initial={false}
        animate={{ opacity: open ? 0 : 1 }}
        transition={{ duration, ease: EASE }}
      >
        <Folder className="w-4 h-4" />
      </motion.span>
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration, ease: EASE }}
      >
        <FolderOpen className="w-4 h-4" />
      </motion.span>
    </span>
  );
}

export default function Sidebar({ workspaceScopes }: { workspaceScopes: WorkspaceScope[] }) {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      chatMetadata: current.chatMetadata,
      draftChat: current.draftChat,
      pendingPermissions: current.pendingPermissions,
      pendingQuestions: current.pendingQuestions,
      sessionLastSeen: current.sessionLastSeen,
      sessionOrder: current.sessionOrder,
      sessions: current.sessions,
    }),
    shallowEqual,
  );
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Sidebar-local chrome state: the search palette and the unread-only filter
  // (Codex-style bell toggle) belong to the sidebar, not the root store.
  const [searchOpen, setSearchOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Per-section count of rows to show; grows by SIDEBAR_VISIBLE_SESSION_LIMIT on
  // each "Show more" so long lists page in (5 + 5 + 5...) rather than loading all.
  const [shownCount, setShownCount] = useState<Map<string, number>>(new Map());
  // Target of the chat row action menu (opened by right-click or the hover
  // "..." button) and the row currently being renamed inline.
  const [rowMenu, setRowMenu] = useState<{ appSessionId: string; x: number; y: number } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const documentVisible = useDocumentVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!documentVisible) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [documentVisible]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleCountFor = (key: string) => shownCount.get(key) ?? SIDEBAR_VISIBLE_SESSION_LIMIT;

  const showMore = (key: string) => {
    setShownCount((prev) => {
      const cur = prev.get(key) ?? SIDEBAR_VISIBLE_SESSION_LIMIT;
      return new Map(prev).set(key, cur + SIDEBAR_VISIBLE_SESSION_LIMIT);
    });
  };

  const showLess = (key: string) => {
    setShownCount((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  };

  const activeId = state.activeAppSessionId;
  const lastSeen = state.sessionLastSeen;
  const chatMetadata = state.chatMetadata;
  const isUnread = useCallback(
    (m: SessionSummary) => sessionIsUnread(m, activeId, lastSeen[m.appSessionId]),
    [activeId, lastSeen],
  );

  const unreadCount = useMemo(
    () =>
      state.sessionOrder
        .map((id) => state.sessions[id])
        .filter(Boolean)
        .filter((m) => !isChatHidden(chatMetadata[m.appSessionId]))
        .filter(isUnread).length,
    [state.sessionOrder, state.sessions, chatMetadata, isUnread],
  );

  const markAllSessionsRead = useCallback(() => {
    dispatch({ type: 'MARK_ALL_SESSIONS_READ', seenAt: Date.now() });
    setUnreadOnly(false);
  }, [dispatch]);

  const startChat = (cwd: string) => {
    dispatch({ type: 'START_CHAT', cwd, executionMode: cwd ? 'worktree' : 'local' });
  };

  const pickAndChat = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    dispatch({ type: 'ADD_WORKSPACE', cwd: dir });
    startChat(dir);
  };

  // New chat follows the active session: workspace chats stay in that folder,
  // folder-less Chats stay folder-less. Draft cwd is only used when nothing is
  // selected (see resolveNewChatCwd).
  const newChat = () => {
    startChat(resolveNewChatCwd(activeSession, state.draftChat));
  };

  // First-run welcome card above Settings: shows on every launch until the
  // user dismisses it, then stays hidden for the profile.
  const [welcomeVisible, setWelcomeVisible] = useState(
    () => !loadSidebarCardSeen(SIDEBAR_WELCOME_CARD_ID),
  );
  const dismissWelcome = () => {
    setWelcomeVisible(false);
    dismissSidebarCard(SIDEBAR_WELCOME_CARD_ID);
  };

  // The sidecar publishes top-level sessions only; children live in the right
  // panel. Pinned chats live in their own section; archived/deleted chats stay
  // out of the normal lists.
  const isListedNormally = useCallback(
    (m: SessionSummary) => {
      const meta = chatMetadata[m.appSessionId];
      return !isChatHidden(meta) && !isChatPinned(meta);
    },
    [chatMetadata],
  );

  const chatSessions = useMemo<SessionSummary[]>(() => {
    const rows = state.sessionOrder
      .map((id) => state.sessions[id])
      .filter(Boolean)
      .filter((m) => !m.cwd)
      .filter(isListedNormally);
    const visible = unreadOnly ? rows.filter(isUnread) : rows;
    return visible.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.sessionOrder, state.sessions, unreadOnly, isUnread, isListedNormally]);

  // Pinned section: every pinned chat regardless of workspace, latest activity
  // first. Empty section hides itself.
  const pinnedSessions = useMemo<SessionSummary[]>(() => {
    const rows = pinnedChats(
      state.sessionOrder.map((id) => state.sessions[id]).filter(Boolean),
      chatMetadata,
    ).sort((a, b) => b.updatedAt - a.updatedAt);
    return unreadOnly ? rows.filter(isUnread) : rows;
  }, [state.sessionOrder, state.sessions, chatMetadata, unreadOnly, isUnread]);

  const workspaces = useMemo(() => {
    const sessions = state.sessionOrder
      .map((id) => state.sessions[id])
      .filter(Boolean)
      .filter(isListedNormally);
    const executionCwds = new Map(
      workspaceScopes.map((scope) => [scope.cwd, scope.executionCwds] as const),
    );
    const sections = buildWorkspaceSections(
      workspaceScopes.map((scope) => scope.cwd),
      sessions,
      { executionCwds },
    );
    // In unread-only mode, drop read sessions and workspaces left empty.
    if (!unreadOnly) return sections;
    return sections
      .map((ws) => ({ ...ws, sessions: ws.sessions.filter(isUnread) }))
      .filter((ws) => ws.sessions.length > 0);
  }, [state.sessionOrder, state.sessions, workspaceScopes, unreadOnly, isUnread, isListedNormally]);

  const handleSelectSession = useCallback(
    (appSessionId: string) => {
      dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
      dispatch({ type: 'SELECT_CHILD', selection: null });
      // Opening a session from the unread-only view drops the filter: the
      // opened session is no longer unread, so keeping it would make the row
      // vanish from under the user.
      if (unreadOnly) setUnreadOnly(false);
    },
    [dispatch, unreadOnly],
  );

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
        !Object.hasOwn(state.sessions, rowMenu.appSessionId) ||
        isChatHidden(chatMetadata[rowMenu.appSessionId]);
      if (gone) setRowMenu(null);
    }
    if (renamingId) {
      const gone =
        !Object.hasOwn(state.sessions, renamingId) || isChatHidden(chatMetadata[renamingId]);
      if (gone) setRenamingId(null);
    }
  }, [rowMenu, renamingId, state.sessions, chatMetadata]);

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

  const rowMenuSession = rowMenuTarget(state.sessions, rowMenu);

  const handleCopyMarkdown = useCallback(
    (appSessionId: string) => {
      if (!Object.hasOwn(state.sessions, appSessionId)) return;
      const session = state.sessions[appSessionId];
      copyChatAsMarkdown(appSessionId, chatDisplayTitle(session, chatMetadata[appSessionId]));
    },
    [state.sessions, chatMetadata],
  );

  const renderRow = (m: SessionSummary) => (
    <SessionRow
      key={m.appSessionId}
      session={m}
      title={chatDisplayTitle(m, chatMetadata[m.appSessionId])}
      active={state.activeAppSessionId === m.appSessionId}
      unread={isUnread(m)}
      running={sessionIsLive(m)}
      attention={sessionAttention(m.appSessionId, state.pendingPermissions, state.pendingQuestions)}
      renaming={renamingId === m.appSessionId}
      now={now}
      onSelect={handleSelectSession}
      onMenu={handleRowMenu}
      onRenameCommit={handleRenameCommit}
      onRenameCancel={handleRenameCancel}
    />
  );

  // Show the latest sessions and tuck the rest behind a "Show more" toggle. The
  // active session is always kept visible so selecting an older one never hides
  // it on the next render.
  const renderSessionList = (sectionKey: string, sessions: SessionSummary[]) => {
    const total = sessions.length;
    const count = Math.min(visibleCountFor(sectionKey), total);
    let visible = sessions.slice(0, count);
    // Keep the active session visible even if it sits below the paged window so
    // selecting an older chat never hides it on the next render.
    if (
      activeSession &&
      sessions.some((m) => m.appSessionId === activeSession.appSessionId) &&
      !visible.some((m) => m.appSessionId === activeSession.appSessionId)
    ) {
      visible = [...visible, state.sessions[activeSession.appSessionId]];
    }
    const remaining = total - count;
    const isExpanded = count > SIDEBAR_VISIBLE_SESSION_LIMIT;
    return (
      <div className="mt-0.5 space-y-0.5">
        {visible.map(renderRow)}
        {(remaining > 0 || isExpanded) && (
          <div className="flex items-center gap-3 pl-3 pr-2 pt-0.5">
            {remaining > 0 && (
              <button
                onClick={() => {
                  showMore(sectionKey);
                }}
                className="text-[12px] text-droid-text-muted hover:text-droid-text transition-colors"
              >
                Show more
              </button>
            )}
            {isExpanded && (
              <button
                onClick={() => {
                  showLess(sectionKey);
                }}
                className="text-[12px] text-droid-text-muted hover:text-droid-text transition-colors"
              >
                Show less
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      data-testid="left-navigation"
      className="w-[280px] h-full flex flex-col border-r border-droid-border shrink-0"
      style={{
        background: 'var(--sidebar-bg)',
        backdropFilter: 'var(--sidebar-blur)',
        WebkitBackdropFilter: 'var(--sidebar-blur)',
      }}
    >
      {/* Empty titlebar strip so traffic lights never collide with chrome. */}
      <div data-electron-drag-region className="h-9 shrink-0" />

      {/* Brand row: wordmark left; Codex-style ghost icon actions right
          (session search palette + unread-only filter). No button chrome —
          hover state only. */}
      <div className="px-3 pb-1 pt-0.5 flex items-center justify-between">
        <BrandMark size={13} className="text-droid-text" />
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => {
              setSearchOpen(true);
            }}
            title="Search sessions and messages"
            aria-label="Search sessions and messages"
            className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
          >
            <Search className="w-4 h-4" strokeWidth={1.75} />
          </button>
          <UnreadFilterActions
            unreadOnly={unreadOnly}
            unreadCount={unreadCount}
            onToggleUnread={() => {
              setUnreadOnly((value) => !value);
            }}
            onMarkAllRead={markAllSessionsRead}
          />
        </div>
      </div>

      <div className="px-2 pb-1.5">
        <button
          onClick={newChat}
          className="group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-droid-text hover:bg-droid-elevated transition-colors"
        >
          <SquarePen className="w-[18px] h-[18px] shrink-0 text-droid-text-secondary transition-colors group-hover:text-droid-text" />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        {unreadOnly && unreadCount === 0 && (
          <div className="px-3 pt-2 pb-1 text-[12px] text-droid-text-muted">
            No unread sessions.
          </div>
        )}
        {/* Pinned — every pinned chat across workspaces, hidden while empty */}
        {pinnedSessions.length > 0 &&
          (() => {
            const open = !collapsed.has('__pinned__');
            return (
              <div>
                <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                  <button
                    onClick={() => {
                      toggleCollapse('__pinned__');
                    }}
                    aria-expanded={open}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                  >
                    <ChevronRight
                      className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                    <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                      Pinned
                    </span>
                  </button>
                </div>
                <Expand open={open}>{renderSessionList('__pinned__', pinnedSessions)}</Expand>
              </div>
            );
          })()}

        {/* Workspaces — folder-scoped, where sessions run (main area) */}
        {(() => {
          // Unread-only mode hides sections that have no unread rows left.
          if (unreadOnly && workspaces.length === 0) return null;
          const open = !collapsed.has('__workspaces__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => {
                    toggleCollapse('__workspaces__');
                  }}
                  aria-expanded={open}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                    Workspaces
                  </span>
                </button>
                <button
                  onClick={() => {
                    void pickAndChat();
                  }}
                  title="Add workspace"
                  className="p-0.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              <Expand open={open}>
                <div className="space-y-2.5">
                  {workspaces.map((ws) => {
                    const wsOpen = !collapsed.has(ws.cwd);
                    return (
                      <div key={ws.cwd}>
                        <div className="group flex items-center gap-1 px-1 py-1">
                          <button
                            onClick={() => {
                              toggleCollapse(ws.cwd);
                            }}
                            aria-expanded={wsOpen}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                          >
                            <WorkspaceFolderIcon open={wsOpen} />
                            <span className="min-w-0 flex-1 truncate text-[13.5px] text-droid-text">
                              {ws.name}
                            </span>
                          </button>
                          <button
                            onClick={() => {
                              startChat(ws.cwd);
                            }}
                            title="New chat here"
                            className="p-0.5 rounded-md text-droid-text-muted/0 group-hover:text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <Expand open={wsOpen}>{renderSessionList(ws.cwd, ws.sessions)}</Expand>
                      </div>
                    );
                  })}

                  {workspaces.length === 0 && (
                    <button
                      onClick={() => {
                        void pickAndChat();
                      }}
                      className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/40 transition-colors"
                    >
                      <FolderOpen className="w-4 h-4 shrink-0" />
                      <span className="text-[13.5px]">Open workspace</span>
                    </button>
                  )}
                </div>
              </Expand>
            </div>
          );
        })()}

        {/* Chats — plain, folder-less conversations */}
        {(() => {
          if (unreadOnly && chatSessions.length === 0) return null;
          const open = !collapsed.has('__chats__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => {
                    toggleCollapse('__chats__');
                  }}
                  aria-expanded={open}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                    Chats
                  </span>
                </button>
              </div>
              <Expand open={open}>
                {chatSessions.length === 0 ? (
                  <div className="mt-0.5 px-3 py-2 text-[12px] text-droid-text-muted">
                    No chats yet.
                  </div>
                ) : (
                  renderSessionList('__chats__', chatSessions)
                )}
              </Expand>
            </div>
          );
        })()}
      </div>

      {/* Settings */}
      <div className="px-2 py-2 border-t border-droid-border">
        <AnimatePresence>
          {welcomeVisible && (
            <SidebarWelcomeCard
              onStart={() => {
                dismissWelcome();
                newChat();
              }}
              onDismiss={dismissWelcome}
            />
          )}
        </AnimatePresence>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              dispatch({ type: 'TOGGLE_SETTINGS' });
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 rounded-lg text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated transition-colors text-left"
            title="Open settings"
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span className="text-[13px] font-medium">Settings</span>
          </button>
          <UpdateButton />
        </div>
      </div>

      <AnimatePresence>
        {searchOpen && (
          <SidebarSearch
            onClose={() => {
              setSearchOpen(false);
            }}
            onOpen={handleSelectSession}
          />
        )}
      </AnimatePresence>

      {rowMenu && (
        <SessionContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          pinned={isChatPinned(chatMetadata[rowMenu.appSessionId])}
          cwd={rowMenuSession?.cwd}
          providerSessionId={rowMenuSession?.providerSessionId}
          onRename={() => {
            setRenamingId(rowMenu.appSessionId);
          }}
          onTogglePin={() => {
            dispatch({
              type: isChatPinned(chatMetadata[rowMenu.appSessionId]) ? 'UNPIN_CHAT' : 'PIN_CHAT',
              appSessionId: rowMenu.appSessionId,
            });
          }}
          onArchive={() => {
            dispatch({ type: 'ARCHIVE_CHAT', appSessionId: rowMenu.appSessionId });
          }}
          onCopyMarkdown={() => {
            handleCopyMarkdown(rowMenu.appSessionId);
          }}
          onClose={closeRowMenu}
        />
      )}
    </aside>
  );
}

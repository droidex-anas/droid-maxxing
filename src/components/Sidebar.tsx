import { canSettleSession } from '../lib/sidebarActivity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { useDocumentVisible } from '../hooks/useDocumentVisible';
import { pickDirectory } from '../lib/desktop';
import { dismissSidebarCard, loadSidebarCardSeen } from '../lib/sidebarCards';
import { bindLazySurfaceIntent } from '../lib/chunkPreloader';
import { SIDEBAR_WELCOME_CARD_ID, SidebarWelcomeCard } from './SidebarWelcomeCard';
import { BrandMark } from './BrandMark';
import SidebarSearch from './SidebarSearch';
import { CirclePlus, Search, Settings, SquarePen } from 'lucide-react';
import { GitPullRequestIcon } from './environment/GithubIcons';
import { resolvePrWorkspaceCwd } from '../features/pull-requests/lib/prWorkspaceCwd';
import { UnreadFilterActions } from './UnreadFilterActions';
import { buildWorkspaceSections, resolveNewChatCwd, type WorkspaceScope } from '../lib/workspaces';
import { SidebarCustomize } from './SidebarCustomize';
import { SidebarPullRequests } from './SidebarPullRequests';
import { SidebarActivity } from './SidebarActivity';
import { useSidebarActivity } from '../hooks/useSidebarActivity';
import { compareSidebarSessions, matchesActivityFilter } from '../lib/sidebarActivity';
import { SidebarWorkspaceList } from './SidebarWorkspaceList';
import { chatDisplayTitle, isChatHidden, isChatPinned, pinnedChats } from '../lib/chatMetadata';
import { useSidebarRowActions } from '../hooks/useSidebarRowActions';
import { SessionContextMenu } from './SessionContextMenu';
import { SessionRow } from './SidebarSessionRow';
import { sessionIsLive, sessionIsUnread } from '../lib/sessions';
import { sessionAttention } from '../lib/sessionAttention';
import type { SessionSummary } from '../types/bridge';
import { SidebarAppUpdateButton } from './SidebarAppUpdateButton';

export default function Sidebar({
  workspaceScopes,
  onShowEarlierSessions,
}: {
  workspaceScopes: WorkspaceScope[];
  onShowEarlierSessions: (executionCwds: readonly string[]) => void;
}) {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      chatMetadata: current.chatMetadata,
      draftChat: current.draftChat,
      earlierSessionsByCwd: current.earlierSessionsByCwd,
      mainView: current.mainView,
      pendingPermissions: current.pendingPermissions,
      pendingQuestions: current.pendingQuestions,
      prWorkspaceCwd: current.prWorkspaceCwd,
      sessionLastSeen: current.sessionLastSeen,
      sessionOrder: current.sessionOrder,
      sessions: current.sessions,
      workspaceCwds: current.workspaceCwds,
    }),
    shallowEqual,
  );
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  // Sidebar-local chrome state: the search palette and the unread-only filter
  // (Codex-style bell toggle) belong to the sidebar, not the root store.
  const [searchOpen, setSearchOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const activity = useSidebarActivity(state);
  const { preferences, view, statusFor } = activity;
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => bindLazySurfaceIntent('settings', settingsButtonRef.current), []);

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

  const compareRows = useCallback(
    (a: SessionSummary, b: SessionSummary) =>
      compareSidebarSessions(a, b, preferences.order, chatMetadata),
    [preferences.order, chatMetadata],
  );
  const visibleSessions = useMemo(
    () =>
      state.sessionOrder
        .map((id) => state.sessions[id])
        .filter(Boolean)
        .filter((m) => !isChatHidden(chatMetadata[m.appSessionId]) && (!unreadOnly || isUnread(m)))
        .filter((m) => matchesActivityFilter(statusFor(m), preferences.filter))
        .sort(compareRows),
    [
      state.sessionOrder,
      state.sessions,
      chatMetadata,
      unreadOnly,
      isUnread,
      statusFor,
      preferences.filter,
      compareRows,
    ],
  );
  const { pinnedSessions, chatSessions, workspaces } = useMemo(() => {
    if (view !== 'workspaces') return { pinnedSessions: [], chatSessions: [], workspaces: [] };
    const ordinarySessions = visibleSessions.filter(
      (m) => !isChatPinned(chatMetadata[m.appSessionId]),
    );
    return {
      pinnedSessions: pinnedChats(visibleSessions, chatMetadata),
      chatSessions: ordinarySessions.filter((m) => !m.cwd),
      workspaces: buildWorkspaceSections(
        workspaceScopes.map((scope) => scope.cwd),
        ordinarySessions,
        {
          executionCwds: new Map(workspaceScopes.map((scope) => [scope.cwd, scope.executionCwds])),
          earlierSessionsByCwd: state.earlierSessionsByCwd,
        },
      )
        .map((ws) => ({ ...ws, sessions: ws.sessions.sort(compareRows) }))
        .filter((ws) => (!unreadOnly && preferences.filter === 'all') || ws.sessions.length > 0),
    };
  }, [
    view,
    visibleSessions,
    chatMetadata,
    workspaceScopes,
    state.earlierSessionsByCwd,
    compareRows,
    unreadOnly,
    preferences.filter,
  ]);

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

  const rowActions = useSidebarRowActions(state.sessions, chatMetadata);
  const {
    rowMenu,
    renamingId,
    rowMenuSession,
    handleRowMenu,
    handleRenameCommit,
    handleRenameCancel,
    closeRowMenu,
    handleCopyMarkdown,
  } = rowActions;

  const renderRow = (m: SessionSummary) => (
    <SessionRow
      key={m.appSessionId}
      session={m}
      title={chatDisplayTitle(m, chatMetadata[m.appSessionId])}
      active={state.activeAppSessionId === m.appSessionId}
      unread={isUnread(m)}
      running={sessionIsLive(m)}
      activityStatus={statusFor(m)}
      attention={sessionAttention(m.appSessionId, state.pendingPermissions, state.pendingQuestions)}
      renaming={renamingId === m.appSessionId}
      now={now}
      onSelect={handleSelectSession}
      onMenu={handleRowMenu}
      onRenameCommit={handleRenameCommit}
      onRenameCancel={handleRenameCancel}
    />
  );

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
            title="Search chats, messages, and PRs"
            aria-label="Search chats, messages, and PRs"
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

      {/* Navigation rows sit at session-row scale so the sidebar reads as one
          list instead of a banner above it. */}
      <div className="px-2 pb-1.5">
        {/* The plus overlays the row's right edge, like a session row's menu,
            so the whole row still highlights as one target. */}
        <div className="group relative">
          <button
            onClick={newChat}
            className="flex w-full items-center gap-2.5 rounded-xl py-1.5 pr-8 pl-2.5 text-left text-[13px] font-medium text-droid-text transition-colors hover:bg-droid-elevated"
          >
            <SquarePen
              className="h-4 w-4 shrink-0 text-droid-text-secondary transition-colors group-hover:text-droid-text"
              strokeWidth={1.75}
            />
            New chat
          </button>
          <button
            data-testid="new-workspaceless-chat"
            onClick={() => {
              startChat('');
            }}
            title="New chat without a workspace"
            aria-label="New chat without a workspace"
            className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
          >
            <CirclePlus className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>
        <button
          data-testid="pull-requests-nav"
          onClick={() => {
            const cwd = resolvePrWorkspaceCwd({
              boundCwd: state.prWorkspaceCwd,
              activeCwd: activeSession?.cwd,
              workspaceKind: activeSession?.workspaceKind,
              workspaceCwds: state.workspaceCwds,
            });
            dispatch({ type: 'OPEN_PULL_REQUESTS', cwd });
          }}
          className={`group mt-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
            state.mainView === 'pull-requests'
              ? 'bg-droid-active text-droid-text'
              : 'text-droid-text hover:bg-droid-elevated'
          }`}
        >
          <span
            className={`flex h-4 w-4 shrink-0 items-center justify-center transition-colors ${
              state.mainView === 'pull-requests'
                ? 'text-droid-text'
                : 'text-droid-text-secondary group-hover:text-droid-text'
            }`}
          >
            <GitPullRequestIcon size={15} />
          </span>
          Pull requests
        </button>
      </div>

      <SidebarCustomize preferences={preferences} onChange={activity.update} />
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        {unreadOnly && unreadCount === 0 && (
          <div className="px-3 pt-2 pb-1 text-[12px] text-droid-text-muted">
            No unread sessions.
          </div>
        )}
        {view === 'activity' ? (
          <SidebarActivity
            key={preferences.limit}
            sessions={visibleSessions}
            activeAppSessionId={state.activeAppSessionId}
            statusFor={statusFor}
            renderRow={renderRow}
            limit={preferences.limit}
            showSettled={preferences.filter === 'settled'}
          />
        ) : view === 'pull-requests' ? (
          <SidebarPullRequests
            key={preferences.limit}
            sessions={visibleSessions}
            metadata={chatMetadata}
            activeAppSessionId={state.activeAppSessionId}
            renderRow={renderRow}
            limit={preferences.limit}
          />
        ) : (
          <SidebarWorkspaceList
            key={preferences.limit}
            limit={preferences.limit}
            workspaces={workspaces}
            chatSessions={chatSessions}
            pinnedSessions={pinnedSessions}
            isFiltered={unreadOnly || preferences.filter !== 'all'}
            activeAppSessionId={state.activeAppSessionId}
            renderRow={renderRow}
            onAddWorkspace={pickAndChat}
            onNewChat={startChat}
            onRemoveWorkspace={(cwd) => {
              dispatch({ type: 'REMOVE_WORKSPACE', cwd });
            }}
            onShowEarlierSessions={onShowEarlierSessions}
          />
        )}
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
            ref={settingsButtonRef}
            onClick={() => {
              dispatch({ type: 'TOGGLE_SETTINGS' });
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 rounded-lg text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated transition-colors text-left"
            title="Open settings"
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span className="text-[13px] font-medium">Settings</span>
          </button>
          <SidebarAppUpdateButton />
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
          settled={rowMenuSession ? statusFor(rowMenuSession) === 'settled' : false}
          onToggleSettled={
            rowMenuSession && canSettleSession(statusFor(rowMenuSession))
              ? () => {
                  if (statusFor(rowMenuSession) === 'settled') activity.reopen(rowMenuSession);
                  else activity.settle(rowMenuSession);
                }
              : undefined
          }
          pinned={isChatPinned(chatMetadata[rowMenu.appSessionId])}
          cwd={rowMenuSession?.cwd}
          providerSessionId={rowMenuSession?.providerSessionId}
          onRename={() => {
            rowActions.startRenaming(rowMenu.appSessionId);
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

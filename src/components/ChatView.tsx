import { useRef, useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { GripVertical, ChevronRight, Square } from 'lucide-react';
import { useStore, type SessionRestore } from '../hooks/useStore';
import { useSessionLive } from '../hooks/useSessionLive';
import { motion } from 'framer-motion';
import {
  MessageFeed,
  WorkingIndicator,
  UserBubble,
  ChatSkeleton,
  TranscriptSkeleton,
  buildGroupedFeed,
} from './chat';
import { readFile } from '../lib/desktop';
import { interruptChild, loadChildHistory, loadSessionHistory } from '../lib/commands';
import { chatDisplayTitle } from '../lib/chatMetadata';
import {
  childSessionActivityForTarget,
  childSessionLabel,
  childSessionMeta,
  findChildSessionForTarget,
  orderedChildSessions,
  shouldRequestReleasedChildHistory,
  transcriptForVisibleSession,
  visibleSessionTarget,
} from '../lib/childSessions';
import type { FileChange } from '../lib/diff';
import { ConversationTimeline } from './ConversationTimeline';
import { WelcomeScreen } from './WelcomeScreen';
import { isChatWorktreePath } from '../lib/chatWorkspace';
import { isEmbedded } from '../lib/embed';
import { useConversationScrollWindow } from '../hooks/useConversationScrollWindow';
import {
  restoreStatusForConversationTimeline,
  useConversationTimeline,
} from '../hooks/useConversationTimeline';
import { transcriptRehydrationLimit } from '../lib/transcriptStoreMemory';
import { VIEWPORT_TRANSCRIPT_POLICY } from '../lib/transcriptWindow';

// While a conversation restores we show an animated placeholder instead of a
// "Restoring…" label, so switching chats feels like content loading in (the way
// most chat apps do) rather than a blank or busy screen.
function RestoringState() {
  return (
    <div className="mx-auto min-w-0 max-w-2xl px-6 py-6">
      <TranscriptSkeleton />
    </div>
  );
}

function RestoreFailedState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="text-[13px] text-droid-text">Couldn&apos;t restore this conversation</span>
      {message && <span className="max-w-md text-[12px] text-droid-text-muted">{message}</span>}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        Retry
      </button>
    </div>
  );
}

function RestoreFailedBanner({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-droid-border bg-droid-elevated/40 px-3 py-2 text-center">
      <span className="text-[12px] text-droid-text-secondary">
        {message ? `Couldn't load earlier messages: ${message}` : "Couldn't load earlier messages"}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-droid-border px-2 py-0.5 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        Retry
      </button>
    </div>
  );
}

function ChatHeader({
  title,
  live,
  sub,
}: {
  title: string;
  live: boolean;
  sub?: { label: string; meta?: string; running: boolean; onBack: () => void; onStop?: () => void };
}) {
  return (
    <div data-electron-drag-region className="shrink-0 flex items-center gap-2 h-9 pr-4 pl-4">
      <div className="flex min-w-0 items-center gap-1.5 rounded-xl bg-droid-elevated/60 pl-2 pr-3 py-1.5">
        <GripVertical className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/40" />
        {sub ? (
          <button
            type="button"
            onClick={sub.onBack}
            title="Back to primary session"
            className="truncate text-[13px] font-medium text-droid-text-muted transition-colors hover:text-droid-text max-w-[200px]"
          >
            {title}
          </button>
        ) : (
          <span
            className={`truncate text-[13px] font-medium max-w-[240px] ${live ? 'shimmer-text' : 'text-droid-text'}`}
          >
            {title}
          </span>
        )}
        {sub && (
          <>
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/50" />
            <span
              className={`truncate text-[13px] font-medium max-w-[200px] ${sub.running ? 'shimmer-text' : 'text-droid-text'}`}
            >
              {sub.label}
            </span>
            {sub.meta && (
              <span className="shrink-0 text-[10px] text-droid-text-muted/70">{sub.meta}</span>
            )}
          </>
        )}
      </div>
      {sub?.onStop && (
        <button
          type="button"
          onClick={sub.onStop}
          title="Stop child session"
          className="flex shrink-0 items-center gap-1 rounded-lg bg-droid-elevated/60 px-2.5 py-1.5 text-[11px] text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <Square className="h-3 w-3" />
          Stop
        </button>
      )}
    </div>
  );
}

export default function ChatView({ rightInset = false }: { rightInset?: boolean }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const allTranscript = activeSession ? (state.transcripts[activeSession.appSessionId] ?? []) : [];

  const visibleTarget = visibleSessionTarget(
    activeSession?.appSessionId,
    state.selectedChild,
    state.childSessions,
    state.childAccess,
  );
  const selectedChildSessionId =
    visibleTarget.kind === 'child' ? visibleTarget.childSessionId : undefined;
  const viewingChildSession = Boolean(selectedChildSessionId);
  const firstUserEvent = allTranscript.find((event) => event.author === 'user');
  const createdWorktreePath =
    activeSession &&
    firstUserEvent &&
    Math.abs(firstUserEvent.ts - activeSession.createdAt) < 60_000 &&
    isChatWorktreePath(activeSession.cwd)
      ? activeSession.cwd
      : undefined;
  const visibleConversationKey = activeSession
    ? `${activeSession.appSessionId}:${selectedChildSessionId ?? 'primary'}`
    : null;

  // Memoized so the subagents dock (and everything derived from it) keeps a
  // stable identity across transcript-token renders; the store's childSessions
  // record only changes when a child session actually updates.
  const activeAppSessionId = activeSession?.appSessionId;
  const childSessions = useMemo(
    () =>
      activeAppSessionId
        ? orderedChildSessions(Object.values(state.childSessions[activeAppSessionId] ?? {}))
        : [],
    [activeAppSessionId, state.childSessions],
  );
  const childSessionIndex = childSessions.findIndex(
    (childSession) => childSession.childSessionId === selectedChildSessionId,
  );
  const selectedChildSession = visibleTarget.kind === 'child' ? visibleTarget.child : undefined;
  const selectedChildLabel = selectedChildSession
    ? childSessionLabel(selectedChildSession, childSessionIndex)
    : 'Child session';
  const selectedChildModel = selectedChildSession?.modelId
    ? (state.models.find((model) => model.id === selectedChildSession.modelId)?.displayName ??
      selectedChildSession.modelId)
    : undefined;
  const selectedChildMeta = selectedChildSession
    ? childSessionMeta(selectedChildSession, selectedChildModel)
    : undefined;
  // childAccess is typed Record-of-Records but keys can be absent at runtime;
  // guard each lookup so a missing entry simply reads as not-opening.
  const selectedChildOpening = Boolean(
    activeSession &&
    selectedChildSessionId &&
    Object.hasOwn(state.childAccess, activeSession.appSessionId) &&
    Object.hasOwn(state.childAccess[activeSession.appSessionId], selectedChildSessionId) &&
    state.childAccess[activeSession.appSessionId][selectedChildSessionId].state === 'opening',
  );

  // Click a spawn name to switch the main chat view to that exact child transcript.
  const openChildSession = useCallback(
    (target: { toolUseId?: string; label?: string }) => {
      const childSession = findChildSessionForTarget(childSessions, target);
      if (childSession)
        dispatch({
          type: 'SELECT_CHILD',
          selection: {
            parentAppSessionId: childSession.parentAppSessionId,
            childSessionId: childSession.childSessionId,
          },
        });
    },
    [childSessions, dispatch],
  );

  // Open the Review pane scoped to the agent's last turn and jump to the clicked
  // file, reused by both the per-turn changes summary and inline diff cards.
  const openReviewFile = useCallback(
    (path: string) => {
      dispatch({ type: 'OPEN_REVIEW_AT', scope: 'last_turn', path });
    },
    [dispatch],
  );
  const openDiff = useCallback(
    (change: FileChange) => {
      openReviewFile(change.path);
    },
    [openReviewFile],
  );

  // Latest activity for a spawn line's inline disclosure: the child's status,
  // start time (for the timer), and its newest meaningful transcript event.
  const childSessionActivity = useCallback(
    (target: { toolUseId?: string; label?: string }) => {
      return childSessionActivityForTarget(childSessions, allTranscript, target);
    },
    [childSessions, allTranscript],
  );

  // Sessions may legitimately be empty right as a wave spawns; the feed renders
  // pending placeholders from the spawn events until they register.
  const subagentsDock = useMemo(() => {
    if (viewingChildSession) return undefined;
    return { sessions: childSessions, models: state.models };
  }, [viewingChildSession, childSessions, state.models]);

  const transcript = useMemo(() => {
    return transcriptForVisibleSession(allTranscript, selectedChildSessionId ?? null);
  }, [allTranscript, viewingChildSession, selectedChildSessionId]);

  // Primary and logical-child transcripts each own their persisted cursor even
  // though live child events share the parent's in-memory event array.
  const historyAppSessionId = activeSession?.appSessionId;
  const historyChildSessionId = selectedChildSessionId;
  // These keyed renderer maps are intentionally sparse at runtime despite
  // their long-standing Record types.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const childHistory =
    historyAppSessionId && historyChildSessionId
      ? state.childHistory[historyAppSessionId]?.[historyChildSessionId]
      : undefined;
  let olderCursor: string | undefined;
  let loadingOlder = false;
  let restore: SessionRestore | undefined = childHistory;
  if (historyChildSessionId) {
    olderCursor = childHistory?.olderCursor;
    loadingOlder = childHistory?.isLoadingOlder ?? false;
  } else if (historyAppSessionId) {
    olderCursor = state.historyCursor[historyAppSessionId];
    loadingOlder = state.historyLoadingOlder[historyAppSessionId] ?? false;
    restore = state.sessionRestore[historyAppSessionId];
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  const retryRestore = useCallback(() => {
    if (!historyAppSessionId) return;
    if (historyChildSessionId) {
      dispatch({
        type: 'CHILD_HISTORY_LOADING',
        parentAppSessionId: historyAppSessionId,
        childSessionId: historyChildSessionId,
      });
      loadChildHistory(historyAppSessionId, historyChildSessionId);
      return;
    }
    dispatch({ type: 'SESSION_RESTORE_START', appSessionId: historyAppSessionId });
    loadSessionHistory(historyAppSessionId);
  }, [dispatch, historyAppSessionId, historyChildSessionId]);
  const tailLen = transcript.length > 0 ? (transcript[transcript.length - 1].text?.length ?? 0) : 0;
  const primaryLive = useSessionLive(activeSession?.appSessionId ?? null);
  const live = visibleTarget.kind === 'child' ? visibleTarget.canInterrupt : primaryLive;
  const draftFolder = state.draftChat?.cwd.split('/').filter(Boolean).pop();

  // A released child tail keeps enough rows for instant switching, then repairs
  // its recent persisted page before that child can page further back.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
  useEffect(() => {
    if (
      !historyAppSessionId ||
      !historyChildSessionId ||
      childHistory?.isLoaded !== false ||
      childHistory.status !== 'paged'
    ) {
      return;
    }
    const access = state.childAccess[historyAppSessionId]?.[historyChildSessionId];
    if (!shouldRequestReleasedChildHistory(access)) return;
    dispatch({
      type: 'CHILD_HISTORY_LOADING',
      parentAppSessionId: historyAppSessionId,
      childSessionId: historyChildSessionId,
    });
    loadChildHistory(
      historyAppSessionId,
      historyChildSessionId,
      undefined,
      transcriptRehydrationLimit(childHistory),
    );
  }, [childHistory, dispatch, historyAppSessionId, historyChildSessionId, state.childAccess]);
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  // Between pressing send on a fresh chat and SESSION_CREATED arriving (the
  // sidecar spawns the session, ~1-2s), there is no active session yet. Show the
  // user's message immediately with a starting cue instead of a blank screen;
  // the real feed (which seeds the same message) takes over once it exists.
  const startingCompose = !activeSession ? Object.values(state.pendingCompose).at(-1) : undefined;

  const isSpec = activeSession?.interactionMode === 'spec';
  const capturedPlan = activeSession ? state.specPlans[activeSession.appSessionId] : undefined;
  const storedSpec = activeSession ? state.sessionSpecs[activeSession.appSessionId] : undefined;
  // The spec stays available after exiting spec mode: keep detecting/loading it
  // whenever this session ever produced one (live mode, captured plan, or a
  // previously stored spec).
  const hadSpec = isSpec || !!capturedPlan || !!storedSpec;

  // The real deliverable in spec mode is a markdown file written to disk
  // (e.g. ~/.factory/specs/<date>-<slug>.md). Detect that path anywhere in the
  // transcript (assistant prose or the write tool's args) and load the file.
  const specPath = useMemo(() => {
    if (!hadSpec) return null;
    const re = /(\/[^\s'"`)]*specs\/[^\s'"`)]+\.md)/;
    for (let i = allTranscript.length - 1; i >= 0; i--) {
      const t = allTranscript[i];
      const hay = `${t.text ?? ''} ${t.toolArgs ? JSON.stringify(t.toolArgs) : ''}`;
      const m = re.exec(hay);
      if (m) return m[1];
    }
    return null;
  }, [hadSpec, allTranscript]);

  const [fileSpec, setFileSpec] = useState<{ path: string; content: string } | null>(null);
  // Re-read on `capturedPlan` changes too: a revised spec rewrites the same file
  // path, so the path alone wouldn't trigger a reload and the card would go stale.
  useEffect(() => {
    if (!specPath) return;
    let cancelled = false;
    void readFile(specPath).then((content) => {
      if (!cancelled && content) setFileSpec({ path: specPath, content });
    });
    return () => {
      cancelled = true;
    };
  }, [specPath, capturedPlan]);

  const hasFileSpec = !!fileSpec && fileSpec.path === specPath;

  // Spec content is ONLY content explicitly produced/stored as spec (#14): the
  // saved spec file or the plan submitted via ExitSpecMode. Normal assistant
  // prose is never reclassified as spec, so pressing Spec can't capture chat.
  const specContent = useMemo(() => {
    if (!hadSpec) return '';
    // 1) The saved spec file (full doc with diagrams/tables) is the best source.
    if (hasFileSpec) return fileSpec.content;
    // 2) The plan the agent submitted via ExitSpecMode.
    if (capturedPlan) return capturedPlan;
    // 3) Previously persisted spec (e.g. after switching sessions and back).
    if (storedSpec?.content) return storedSpec.content;
    return '';
  }, [hadSpec, hasFileSpec, fileSpec, capturedPlan, storedSpec]);

  // Persist the best spec we have so the card, wiki reader, and right-panel
  // button survive exiting spec mode and switching between sessions.
  useEffect(() => {
    if (!activeAppSessionId || !specContent) return;
    const title = /^#{1,3}\s+(.+)$/m.exec(specContent)?.[1]?.trim() ?? 'Specification';
    // Preserve the existing file path when the current source is not file-backed
    // (e.g. a captured plan), so the store never loses a known path on refresh.
    const path = hasFileSpec ? fileSpec.path : storedSpec?.path;
    dispatch({
      type: 'SPEC_SET',
      appSessionId: activeAppSessionId,
      path,
      title,
      content: specContent,
    });
  }, [activeAppSessionId, specContent, hasFileSpec, fileSpec, storedSpec?.path, dispatch]);

  // Build the grouped feed once and share it: MessageFeed renders it and the
  // timeline derives its anchors from the same items, so switching sessions
  // doesn't run buildFeed/groupTurns twice on every render.
  const feedItems = useMemo(
    // Primary view groups each turn's spawns into one subagents-dock wave item;
    // child-session views keep the plain per-spawn lines.
    () =>
      buildGroupedFeed(transcript, live, {
        childSessionCards: true,
        specContent,
        changes: true,
        groupChildSessions: !viewingChildSession,
      }),
    [transcript, live, specContent, viewingChildSession],
  );
  const { timelineAnchors, isTimelinePriming, isAutoPagingOlderHistory } = useConversationTimeline({
    feedItems,
    isViewingChildSession: viewingChildSession,
    conversationKey: visibleConversationKey,
    historyAppSessionId,
    olderCursor,
    isLoadingOlder: loadingOlder,
    isTranscriptWindowAtCapacity:
      allTranscript.length > VIEWPORT_TRANSCRIPT_POLICY.highWaterEvents ||
      (activeSession
        ? (state.transcriptRetainedCost[activeSession.appSessionId] ?? 0) >
          VIEWPORT_TRANSCRIPT_POLICY.highWaterCost
        : false),
    restoreStatus: restoreStatusForConversationTimeline(restore?.status, !isEmbedded()),
  });
  const { onScroll, requestOlderHistory } = useConversationScrollWindow({
    scrollRef,
    visibleConversationKey,
    isViewingChildSession: viewingChildSession,
    activeAppSessionId,
    historyAppSessionId,
    historyChildSessionId,
    olderCursor,
    isLoadingOlder: loadingOlder,
    transcriptLength: transcript.length,
    transcriptTailLength: tailLen,
    retainedTranscriptLength: transcript.length,
    isConversationLive: live,
    isAutoPagingOlderHistory,
    dispatch,
  });

  // Old/large chats restore only a recent window, which can hold too few final
  // responses for the rail to be useful. Page older history in (via the same
  // prepend-stable path as scroll prefetch) until there are enough anchors or
  // the compaction chain is exhausted, so the timeline works on any chat.
  useEffect(() => {
    if (!isAutoPagingOlderHistory) return;
    requestOlderHistory();
  }, [isAutoPagingOlderHistory, requestOlderHistory]);

  const stopSelectedChild =
    visibleTarget.kind === 'child' && visibleTarget.canInterrupt
      ? () => {
          interruptChild(visibleTarget.parentAppSessionId, visibleTarget.childSessionId);
        }
      : undefined;
  const chatHeaderSub = viewingChildSession
    ? {
        label: selectedChildLabel,
        meta: selectedChildMeta,
        running: live,
        onBack: () => {
          dispatch({ type: 'SELECT_CHILD', selection: null });
        },
        onStop: stopSelectedChild,
      }
    : undefined;
  const openSpecWiki = activeAppSessionId
    ? () => {
        dispatch({ type: 'SPEC_OPEN_WIKI', appSessionId: activeAppSessionId });
      }
    : undefined;

  let emptyChildActivity: ReactNode;
  if (visibleTarget.kind === 'child' && visibleTarget.canInterrupt) {
    emptyChildActivity = (
      <WorkingIndicator
        label={`${selectedChildLabel} is working`}
        startTs={visibleTarget.child.startedAt}
      />
    );
  } else if (selectedChildOpening) {
    emptyChildActivity = <WorkingIndicator label={`Loading ${selectedChildLabel} activity`} />;
  } else {
    emptyChildActivity = (
      <span className="text-[13px] text-droid-text-muted">
        No activity captured for {selectedChildLabel}.
      </span>
    );
  }

  let conversationContent: ReactNode;
  if (activeSession && transcript.length > 0) {
    conversationContent = (
      <motion.div
        key={`${activeAppSessionId ?? 'none'}:${viewingChildSession ? String(selectedChildSessionId) : 'primary'}`}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto min-w-0 px-6 py-6 max-w-2xl"
      >
        {restore?.status === 'failed' && (
          <RestoreFailedBanner message={restore.error} onRetry={retryRestore} />
        )}
        <div
          aria-atomic="true"
          aria-live="polite"
          className={loadingOlder ? 'pb-2 text-center text-[11px] text-droid-text-muted/70' : ''}
        >
          {loadingOlder ? 'Loading earlier messages…' : ''}
        </div>
        <MessageFeed
          events={transcript}
          items={feedItems}
          pending={live}
          cwd={activeSession.cwd}
          onOpenDiff={openDiff}
          onOpenReviewFile={openReviewFile}
          onOpenChildSession={openChildSession}
          childSessionActivity={childSessionActivity}
          subagentsDock={subagentsDock}
          specContent={specContent}
          onOpenSpecWiki={openSpecWiki}
          createdWorktreePath={!viewingChildSession ? createdWorktreePath : undefined}
        />
      </motion.div>
    );
  } else if (activeSession && restore?.status === 'failed') {
    conversationContent = <RestoreFailedState message={restore.error} onRetry={retryRestore} />;
  } else if (activeSession && viewingChildSession && restore?.status === 'loading') {
    conversationContent = <RestoringState />;
  } else if (activeSession && viewingChildSession) {
    conversationContent = (
      <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-8 text-center">
        {selectedChildSession?.prompt && (
          <div className="max-w-lg rounded-xl bg-droid-elevated/40 px-4 py-3 text-left">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-droid-text-muted">
              Task
            </div>
            <div className="text-[12.5px] leading-relaxed text-droid-text-secondary whitespace-pre-wrap break-words">
              {selectedChildSession.prompt}
            </div>
          </div>
        )}
        {emptyChildActivity}
      </div>
    );
  } else if (activeSession && restore?.status === 'loading') {
    conversationContent = <RestoringState />;
  } else if (startingCompose) {
    conversationContent = (
      <div className="mx-auto min-w-0 max-w-2xl px-6 py-6">
        <UserBubble event={startingCompose} />
        <div className="mt-5">
          <ChatSkeleton />
        </div>
      </div>
    );
  } else {
    conversationContent = (
      <WelcomeScreen
        folder={draftFolder}
        onSeedPrompt={(text) => {
          dispatch({ type: 'SEED_COMPOSER', text });
        }}
      />
    );
  }

  return (
    <div data-testid="chat-view" className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {activeSession && (
        <ChatHeader
          title={chatDisplayTitle(activeSession, state.chatMetadata[activeSession.appSessionId])}
          live={live}
          sub={chatHeaderSub}
        />
      )}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        {activeSession && !isTimelinePriming && timelineAnchors.length >= 2 && (
          <ConversationTimeline scrollRef={scrollRef} anchors={timelineAnchors} />
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden"
          style={{
            paddingRight: rightInset ? 312 : undefined,
            transition: 'padding-right 0.2s ease',
            overflowAnchor: 'none',
          }}
        >
          {conversationContent}
        </div>
      </div>
    </div>
  );
}

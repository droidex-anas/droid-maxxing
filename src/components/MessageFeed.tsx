import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { TranscriptEvent } from '../types/bridge';
import { SpecRenderer } from './SpecRenderer';
import type { FileChange } from '../lib/diff';
import { childSessionInfo } from '../lib/tools';
import type { ChildSessionActivity, ChildSessionTarget } from '../lib/childSessions';
import { DEFAULT_TOOL_ACTIVITY, type ToolActivityDensity } from '../lib/toolActivity';
import type { ConversationViewportLayout } from '../hooks/conversationViewportAnchor';
import { asChunkedSequence } from '../lib/chunkedSequence';
import { ConversationList, type ConversationListHandle } from './ConversationList';
import { takeFeedRowEntrance } from './conversationListState';
import { FeedRow, optionalFeedRowProps, type FeedRowsSharedProps } from './messageFeedRows';
import { WorktreeCreatedCard } from './WorktreeCreatedCard';
import {
  appendedFeedItemKeysFromProjection,
  projectFinalResponseKeys,
  rememberFreshAppResponses,
  type FinalResponseKeyState,
  type FreshAppResponseState,
} from './messageFeedState';
import { buildFeed, isCompactingStatus, type FeedItem } from './chatFeed';
import { groupTurns, tailTimestamp, trailingSubagentPoll } from './chatFeedTurns';
import { FeedItemView, feedItemPropsEqual } from './chat';
import { WorkingIndicator } from './transcript/primitives';
import type { SubagentsDockData } from './SubagentsDock';

/* ── Collapsed spec card shown inline in chat (chevron to expand) ── */
const InlineSpecCard = memo(function InlineSpecCard({
  content,
  onOpenWiki,
}: {
  content: string;
  onOpenWiki?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = useMemo(
    () => /^#{1,3}\s+(.+)$/m.exec(content)?.[1]?.trim() ?? 'Specification',
    [content],
  );
  const sections = useMemo(() => (content.match(/^#{1,3}\s+/gm) ?? []).length, [content]);

  return (
    <div className="rounded-xl border border-droid-border bg-droid-elevated/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          onClick={() => {
            setExpanded((e) => !e);
          }}
          className="flex items-center gap-2 flex-1 min-w-0 text-left group"
        >
          <ChevronRight
            className={`w-4 h-4 shrink-0 text-droid-text-muted transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="truncate text-[13px] font-medium text-droid-text">{title}</span>
          {sections > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-droid-text-muted/70">
              {sections} sections
            </span>
          )}
        </button>
        {onOpenWiki && (
          <button
            onClick={onOpenWiki}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-droid-text-secondary bg-droid-elevated/50 border border-droid-border hover:bg-droid-elevated/80 hover:text-droid-text transition-colors"
          >
            Read spec
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: 'linear' }}
          >
            <div className="px-4 pb-4 pt-2 border-t border-droid-border">
              <SpecRenderer content={content} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/* ── The activity feed (list only; parent owns the scroll container) ── */
export function MessageFeed({
  events,
  items: providedItems,
  pending,
  cwd,
  onOpenDiff,
  onOpenReviewFile,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  specContent,
  onOpenSpecWiki,
  createdWorktreePath,
  onMountedRowsChange,
  scrollElementRef,
  viewportLayoutRef,
  listRef,
  initialScrollOffset,
  updateKind = 'full',
  rebuiltFromItemIndex = 0,
  density = DEFAULT_TOOL_ACTIVITY.density,
  inlineDiffs = DEFAULT_TOOL_ACTIVITY.inlineDiffs,
}: {
  events: TranscriptEvent[];
  items?: FeedItem[];
  pending: boolean;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  onOpenReviewFile?: (path: string) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  // When set (normal chat sessions only), the per-spawn child session lines are
  // replaced by one grouping subagents dock at the first spawn's position.
  subagentsDock?: SubagentsDockData;
  specContent?: string;
  onOpenSpecWiki?: () => void;
  createdWorktreePath?: string;
  onMountedRowsChange?: (count: number) => void;
  scrollElementRef?: RefObject<HTMLElement | null>;
  viewportLayoutRef?: RefObject<ConversationViewportLayout | null>;
  listRef?: RefObject<ConversationListHandle | null>;
  initialScrollOffset?: number;
  updateKind?: 'full' | 'append' | 'prepend';
  rebuiltFromItemIndex?: number;
  // Render-only tool-activity detail level; forwarded to every row.
  density?: ToolActivityDensity;
  // Whether folded diff runs render expanded by default.
  inlineDiffs?: boolean;
}) {
  // Child session cards, waiting label, and live timers are enabled only for the
  // chat/spec feed (which supplies onOpenChildSession). Per-turn change summaries
  // are gated separately on onOpenReviewFile: Mission Control supplies
  // onOpenChildSession for its orchestrator view but has no Review tab to open
  // files in, so non-interactive Changes cards must not appear there.
  const rich = !!onOpenChildSession;
  const changes = !!onOpenReviewFile;

  // The parent rebuilds these callbacks every streaming token (they close over
  // the growing transcript). Wrap them in stable identities that read the latest
  // version through a ref, so the memoized FeedItemView can actually skip
  // unchanged items instead of re-rendering the whole feed on every token. Keep
  // them undefined when the parent supplies no handler, so absent affordances
  // (e.g. non-clickable diffs in the chat feed) stay absent.
  const cbRef = useRef({ onOpenDiff, onOpenReviewFile, onOpenChildSession, childSessionActivity });
  cbRef.current = { onOpenDiff, onOpenReviewFile, onOpenChildSession, childSessionActivity };
  const hasOpenDiff = !!onOpenDiff;
  const hasOpenReviewFile = !!onOpenReviewFile;
  const hasChildSessionActivity = !!childSessionActivity;
  const stableOnOpenDiff = useMemo(
    () => (hasOpenDiff ? (c: FileChange) => cbRef.current.onOpenDiff?.(c) : undefined),
    [hasOpenDiff],
  );
  const stableOnOpenReviewFile = useMemo(
    () => (hasOpenReviewFile ? (p: string) => cbRef.current.onOpenReviewFile?.(p) : undefined),
    [hasOpenReviewFile],
  );
  const stableOnOpenChildSession = useMemo(
    () => (rich ? (t: ChildSessionTarget) => cbRef.current.onOpenChildSession?.(t) : undefined),
    [rich],
  );
  const stableChildSessionActivity = useMemo(
    () =>
      hasChildSessionActivity
        ? (t: ChildSessionTarget) => cbRef.current.childSessionActivity?.(t)
        : undefined,
    [hasChildSessionActivity],
  );

  // With the subagents dock, each contiguous run of spawns becomes one wave
  // item: the dock card renders right where that turn spawned its agents (live
  // while the turn is in flight) and folds into the turn's Worked group once
  // the turn completes.
  const dockEnabled = !!subagentsDock;
  const items = useMemo(
    () =>
      asChunkedSequence(
        providedItems ??
          groupTurns(
            buildFeed(events, { childSessionCards: rich, groupChildSessions: dockEnabled }),
            pending,
            specContent,
            changes,
          ),
      ),
    [providedItems, events, pending, rich, changes, specContent, dockEnabled],
  );
  const feedIdentity = `${events[0]?.appSessionId ?? ''}:${events[0]?.sourceSessionId ?? ''}`;
  const freshAppResponsesRef = useRef<FreshAppResponseState | null>(null);
  const freshAppResponseState = useMemo(
    () => rememberFreshAppResponses(freshAppResponsesRef.current, feedIdentity, items, pending),
    [feedIdentity, items, pending],
  );
  useEffect(() => {
    freshAppResponsesRef.current = freshAppResponseState;
  }, [freshAppResponseState]);
  const freshAppResponseTexts = freshAppResponseState.texts;
  const renderedFeedRef = useRef<{ identity: string; items: FeedItem[] } | null>(null);
  const previousFeed = renderedFeedRef.current;
  useEffect(() => {
    renderedFeedRef.current = {
      identity: feedIdentity,
      items,
    };
  }, [feedIdentity, items]);
  // Track item identity (not list index) so prepended older-history items and
  // every already-rendered item stay still; only genuinely appended tail items
  // enter with the rise animation.
  const animateKeys = appendedFeedItemKeysFromProjection(
    items,
    previousFeed,
    feedIdentity,
    updateKind,
    rebuiltFromItemIndex,
  );
  const enteredKeysRef = useRef(new Set<string>());
  const enteredIdentityRef = useRef(feedIdentity);
  if (enteredIdentityRef.current !== feedIdentity) {
    enteredKeysRef.current = new Set();
    enteredIdentityRef.current = feedIdentity;
  }

  // The copy button appears only on a turn's final model response.
  const finalResponseStateRef = useRef<FinalResponseKeyState | null>(null);
  const finalResponseState = useMemo(
    () => projectFinalResponseKeys(finalResponseStateRef.current, feedIdentity, items, updateKind),
    [feedIdentity, items, updateKind],
  );
  useEffect(() => {
    finalResponseStateRef.current = finalResponseState;
  }, [finalResponseState]);
  const worktreeInsertAfter = createdWorktreePath
    ? items.findIndex((item) => item.type === 'message' && item.event.author === 'user')
    : -1;

  const lastIdx = items.length - 1;
  // Empty feeds are real (a fresh session), so the tail is genuinely optional.
  const last: FeedItem | undefined = items.length > 0 ? items[lastIdx] : undefined;
  const showSpecCard = (specContent?.length ?? 0) > 0;

  // Compaction is in progress when the latest status line announces it and no
  // completion marker has arrived yet. Drives the centered "Compacting…" shimmer.
  const compacting = last?.type === 'status' && isCompactingStatus(last.event.text);

  // A child session line or dock card self-indicates only while it is still
  // running (it shows its own "Running … <timer>"). Once everything completes,
  // the orchestrator may still be working, so let the global cue show instead
  // of looking idle.
  const lastChildSessionRunning =
    last?.type === 'child_session' &&
    childSessionActivity?.({
      toolUseId: last.event.toolUseId,
      label: childSessionInfo(last.event.toolArgs).label,
    })?.status === 'running';
  const lastDockRunning =
    last?.type === 'child_sessions' &&
    last.events.some(
      (e) =>
        childSessionActivity?.({
          toolUseId: e.toolUseId,
          label: childSessionInfo(e.toolArgs).label,
        })?.status === 'running',
    );
  // The tail already animates its own shimmer/caret for these; otherwise show an explicit cue.
  const tailSelfIndicates =
    !!last &&
    (last.type === 'thinking' ||
      last.type === 'status' ||
      (last.type === 'child_session' && lastChildSessionRunning) ||
      (last.type === 'child_sessions' && lastDockRunning) ||
      (last.type === 'message' && last.event.author !== 'user'));
  // While the parent polls its subagents nothing in the feed represents that
  // work, so the cue speaks for it and the settled tail stops animating.
  const subagentPoll = useMemo(
    () => trailingSubagentPoll(events, dockEnabled),
    [events, dockEnabled],
  );
  // A dock tail whose children are still running already speaks for the wave
  // with its own pills, timers and total, so the poll cue would only repeat it.
  const showWorking = pending && (subagentPoll ? !lastDockRunning : !tailSelfIndicates);
  const workingLabel = subagentPoll
    ? 'Checking subagents'
    : last?.type === 'tools'
      ? 'Running'
      : last?.type === 'diff' || last?.type === 'diffs'
        ? 'Updating files'
        : 'Working';
  // Time the check from the poll itself; the visible tail can be minutes old.
  const workingStart = rich ? (subagentPoll?.ts ?? tailTimestamp(last)) : undefined;
  const rowSharedProps = useMemo<FeedRowsSharedProps>(
    () => ({
      pending,
      cwd,
      onOpenDiff: stableOnOpenDiff,
      onOpenReviewFile: stableOnOpenReviewFile,
      onOpenChildSession: stableOnOpenChildSession,
      childSessionActivity: stableChildSessionActivity,
      subagentsDock,
      liveTiming: rich,
      specContent,
      density,
      inlineDiffs,
    }),
    [
      pending,
      cwd,
      stableOnOpenDiff,
      stableOnOpenReviewFile,
      stableOnOpenChildSession,
      stableChildSessionActivity,
      subagentsDock,
      rich,
      specContent,
      density,
      inlineDiffs,
    ],
  );
  const optionalItemProps = optionalFeedRowProps(rowSharedProps);
  const subagentPollActive = Boolean(subagentPoll);

  return (
    <div className="space-y-4">
      {showSpecCard && (
        <div className="mx-auto min-w-0 max-w-2xl">
          <InlineSpecCard content={specContent ?? ''} onOpenWiki={onOpenSpecWiki} />
        </div>
      )}

      <ConversationList
        items={items}
        {...(scrollElementRef !== undefined ? { scrollElementRef } : {})}
        {...(viewportLayoutRef !== undefined ? { viewportLayoutRef } : {})}
        {...(listRef !== undefined ? { listRef } : {})}
        {...(initialScrollOffset !== undefined ? { initialScrollOffset } : {})}
        {...(onMountedRowsChange !== undefined ? { onMountedRowsChange } : {})}
      >
        {(item, index) => (
          <>
            <FeedRow
              item={item}
              itemView={FeedItemView}
              areItemPropsEqual={feedItemPropsEqual}
              animateOnMount={takeFeedRowEntrance(item.key, animateKeys, enteredKeysRef.current)}
              live={pending && index === lastIdx && !subagentPollActive}
              autoPlayAppBlocks={
                item.type === 'message' &&
                item.event.author !== 'user' &&
                freshAppResponseTexts.has(item.event.text ?? '')
              }
              sessionLive={pending}
              compacting={compacting && index === lastIdx}
              {...optionalItemProps}
              liveTiming={rowSharedProps.liveTiming}
              isFinalResponse={
                finalResponseState.settledKeys.has(item.key) ||
                finalResponseState.liveKeys.has(item.key)
              }
            />
            {index === worktreeInsertAfter && createdWorktreePath ? (
              <div className="mx-auto min-w-0 max-w-2xl">
                <WorktreeCreatedCard path={createdWorktreePath} />
              </div>
            ) : null}
          </>
        )}
      </ConversationList>

      {showWorking && (
        <div className="mx-auto min-w-0 max-w-2xl">
          <WorkingIndicator label={workingLabel} startTs={workingStart} />
        </div>
      )}
    </div>
  );
}

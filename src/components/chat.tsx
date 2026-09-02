import { memo } from 'react';
import { hasAppBlock } from './appBlockRuntime';
import type { FileChange } from '../lib/diff';
import { copyTextForMessage } from '../features/transcript-reach/transcriptCopy';
import { useStreamingActivity } from '../hooks/streamingText';
import { childSessionInfo } from '../lib/tools';
import type { ChildSessionActivity, ChildSessionTarget } from '../lib/childSessions';
import { DEFAULT_TOOL_ACTIVITY, type ToolActivityDensity } from '../lib/toolActivity';
import { MessageBody } from './MessageBody';
import { DiffCard } from './DiffView';
import type { SubagentsDockData } from './SubagentsDock';
import TurnChangesPanel from './TurnChangesPanel';
import { StreamingCaret } from './StreamingCaret';
import { isCompactionCompleteStatus, sameFeedEvents, type FeedItem } from './chatFeed';
import { CompactingIndicator, CompactionDivider, CopyButton } from './transcript/primitives';
import { ErrorLine, ThinkingItem } from './transcript/rows';
import { DiffGroup, ToolGroupItem, WorkedGroup } from './transcript/groups';
import { UserBubble } from './transcript/UserBubble';
import { ChildSessionLine, ChildSessionsWave } from './transcript/ChildSessionLine';

export { StreamingCaret } from './StreamingCaret';
// Row chrome and renderers live in the transcript modules; re-export the ones
// callers and tests historically imported from here.
export { ChatSkeleton, TranscriptSkeleton, WorkingIndicator } from './transcript/primitives';
export { correlateResults } from './transcript/rows';
export { WebFetchBody, fetchSizeBadge } from './transcript/webCards';
export { UserBubble } from './transcript/UserBubble';
export { childSessionLineIsRunning } from './transcript/ChildSessionLine';
export { sameFeedEvents } from './chatFeed';

export interface FeedItemViewProps {
  item: FeedItem;
  live: boolean;
  autoPlayAppBlocks?: boolean;
  // True while the whole turn is still streaming, regardless of where this item
  // sits. Subagent waves need this rather than `live`: work continues after the
  // wave stops being the last item (a plan update or assistant text follows it),
  // and treating that as settled froze the card on "Never started".
  sessionLive?: boolean;
  compacting?: boolean;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  onOpenReviewFile?: (path: string) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  // Store child sessions + models for the subagents dock. Every child_sessions
  // wave item resolves its own subset from this list and renders one card per
  // wave. Wave items only exist when this is set; views without it (Mission
  // Control, child-session views) get per-spawn child_session lines instead.
  subagentsDock?: SubagentsDockData;
  liveTiming?: boolean;
  specContent?: string;
  isFinalResponse?: boolean;
  // Render-only detail level for tool runs (aggregate line / per-tool lines /
  // inline bodies). Never a feed input: changing it re-renders rows in place.
  density?: ToolActivityDensity;
  // Whether folded diff runs render expanded by default.
  inlineDiffs?: boolean;
}

function densityOf(props: FeedItemViewProps): ToolActivityDensity {
  return props.density ?? DEFAULT_TOOL_ACTIVITY.density;
}

// The spec is rendered in the pinned card. Suppress an assistant message only
// when it is exactly that spec text (avoid double-rendering the same plan);
// never hide other prose just because spec mode is active (#14).
function isSpecEcho(text: string, specContent: string | undefined): boolean {
  return Boolean(specContent && text.trim() && text.trim() === specContent.trim());
}

// The assistant's streaming text row. The caret means "text is flowing": it
// stops after a short idle gap (and never appears for app blocks, which render
// their own building status) so a wedged pending flag cannot leave it blinking.
// Copy belongs to the turn's settled final response only — mid-turn notes and
// anything still streaming get neither caret-forever nor a copy button.
const AssistantMessage = memo(function AssistantMessage({
  text,
  live,
  sessionLive,
  isFinalResponse,
  autoPlayAppBlocks,
  cacheId,
  specContent,
}: {
  text: string;
  live: boolean;
  sessionLive?: boolean;
  isFinalResponse?: boolean;
  autoPlayAppBlocks: boolean;
  cacheId: string;
  specContent?: string;
}) {
  const appOwnsLiveStatus = live && hasAppBlock(text);
  const typing = useStreamingActivity(text, live && !appOwnsLiveStatus);
  if (isSpecEcho(text, specContent)) return null;
  return (
    <div className="group/msg">
      <MessageBody
        text={text}
        live={live}
        autoPlayAppBlocks={autoPlayAppBlocks}
        cacheId={cacheId}
      />
      {typing ? <StreamingCaret /> : null}
      {!live && !sessionLive && isFinalResponse && text.trim() ? (
        <div className="mt-1.5 -ml-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
          <CopyButton text={copyTextForMessage(text)} />
        </div>
      ) : null}
    </div>
  );
});

function inlineDiffsOf(props: FeedItemViewProps): boolean {
  return props.inlineDiffs ?? DEFAULT_TOOL_ACTIVITY.inlineDiffs;
}

// Lets memo skip the many static items while a response streams, re-rendering
// only the growing tail.
export function feedItemPropsEqual(prev: FeedItemViewProps, next: FeedItemViewProps): boolean {
  // Live-updating spawn lines and worked groups still re-render; a child_sessions
  // wave skips unless this card's events, dock (including throttled snapshots),
  // or liveness changed. Sibling feed rows compare as usual below.
  if (next.item.type === 'child_sessions') {
    return (
      prev.live === next.live &&
      prev.sessionLive === next.sessionLive &&
      prev.subagentsDock === next.subagentsDock &&
      prev.onOpenChildSession === next.onOpenChildSession &&
      prev.childSessionActivity === next.childSessionActivity &&
      sameFeedEvents(prev.item, next.item)
    );
  }
  if (next.item.type === 'child_session' || next.item.type === 'worked') return false;
  return (
    prev.live === next.live &&
    prev.autoPlayAppBlocks === next.autoPlayAppBlocks &&
    prev.sessionLive === next.sessionLive &&
    prev.compacting === next.compacting &&
    prev.liveTiming === next.liveTiming &&
    prev.specContent === next.specContent &&
    prev.cwd === next.cwd &&
    prev.isFinalResponse === next.isFinalResponse &&
    densityOf(prev) === densityOf(next) &&
    inlineDiffsOf(prev) === inlineDiffsOf(next) &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenReviewFile === next.onOpenReviewFile &&
    prev.onOpenChildSession === next.onOpenChildSession &&
    prev.childSessionActivity === next.childSessionActivity &&
    sameFeedEvents(prev.item, next.item)
  );
}

export const FeedItemView = memo(function FeedItemView({
  item,
  live,
  autoPlayAppBlocks = false,
  sessionLive,
  compacting,
  cwd,
  onOpenDiff,
  onOpenReviewFile,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  liveTiming,
  specContent,
  isFinalResponse,
  density = DEFAULT_TOOL_ACTIVITY.density,
  inlineDiffs = DEFAULT_TOOL_ACTIVITY.inlineDiffs,
}: FeedItemViewProps) {
  switch (item.type) {
    case 'message': {
      if (item.event.author === 'user') return <UserBubble event={item.event} />;
      return (
        <AssistantMessage
          text={item.event.text ?? ''}
          live={live}
          sessionLive={sessionLive}
          isFinalResponse={isFinalResponse}
          autoPlayAppBlocks={autoPlayAppBlocks}
          cacheId={item.key}
          specContent={specContent}
        />
      );
    }
    case 'thinking':
      return (
        <ThinkingItem
          text={item.event.text ?? ''}
          durationMs={item.durationMs}
          active={live}
          startTs={liveTiming ? item.event.ts : undefined}
        />
      );
    case 'child_session':
      return (
        <ChildSessionLine
          event={item.event}
          onOpen={onOpenChildSession}
          activity={childSessionActivity?.({
            toolUseId: item.event.toolUseId,
            label: childSessionInfo(item.event.toolArgs).label,
          })}
        />
      );
    case 'child_sessions': {
      // Wave items are only built when dock data is passed (buildFeed gates on
      // it), so a missing dock here is a wiring bug; views that keep per-spawn
      // lines produce child_session items, never this case.
      if (!subagentsDock) return null;
      return (
        <ChildSessionsWave
          item={item}
          dock={subagentsDock}
          live={sessionLive}
          onOpen={onOpenChildSession}
          activity={childSessionActivity}
        />
      );
    }
    case 'status': {
      const text = item.event.text ?? '';
      if (item.event.kind === 'compaction') return <CompactionDivider compactType="auto" />;
      if (compacting) return <CompactingIndicator />;
      if (isCompactionCompleteStatus(text))
        return <CompactionDivider compactType={item.event.compactType} />;
      return live ? (
        <span className="shimmer-text text-[13px] font-medium">{text}</span>
      ) : (
        <span className="block text-[13px] text-droid-text-muted leading-relaxed break-words">
          {text}
        </span>
      );
    }
    case 'error':
      return <ErrorLine text={item.event.text ?? ''} />;
    case 'diff':
      return (
        <DiffCard
          change={item.change}
          onOpen={
            onOpenDiff
              ? () => {
                  onOpenDiff(item.change);
                }
              : undefined
          }
        />
      );
    case 'diffs':
      return <DiffGroup changes={item.changes} onOpenDiff={onOpenDiff} inlineDiffs={inlineDiffs} />;
    case 'tools':
      return <ToolGroupItem events={item.events} active={live} density={density} />;
    case 'turnChanges':
      return <TurnChangesPanel item={item} cwd={cwd} onOpenFile={onOpenReviewFile} />;
    case 'worked':
      // Completed turns fold identically at every density; the density reaches
      // the folded children so a compact feed keeps aggregate lines inside an
      // expanded Worked group (two-level disclosure).
      return (
        <WorkedGroup item={item}>
          {item.items.map((child) => (
            <FeedItemView
              key={child.key}
              item={child}
              live={false}
              cwd={cwd}
              onOpenDiff={onOpenDiff}
              onOpenReviewFile={onOpenReviewFile}
              onOpenChildSession={onOpenChildSession}
              childSessionActivity={childSessionActivity}
              subagentsDock={subagentsDock}
              specContent={specContent}
              density={density}
              inlineDiffs={inlineDiffs}
            />
          ))}
        </WorkedGroup>
      );
  }
}, feedItemPropsEqual);

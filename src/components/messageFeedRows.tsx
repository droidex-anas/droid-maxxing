import { memo, useRef, type ComponentType } from 'react';

import { feedRowId } from '../hooks/conversationViewportAnchor';
import {
  feedRowReachClassName,
  useTranscriptReachChrome,
} from '../features/transcript-reach/transcriptReachContext';
import type { ChildSessionActivity, ChildSessionTarget } from '../lib/childSessions';
import type { FileChange } from '../lib/diff';
import type { ToolActivityDensity } from '../lib/toolActivity';
import { hasAppBlock } from './appBlockRuntime';
import type { FeedItemViewProps } from './chat';
import type { SubagentsDockData } from './SubagentsDock';

export interface FeedRowProps extends FeedItemViewProps {
  animateOnMount: boolean;
  itemView: ComponentType<FeedItemViewProps>;
  areItemPropsEqual: (previous: FeedItemViewProps, next: FeedItemViewProps) => boolean;
}

export function areFeedRowPropsEqual(previous: FeedRowProps, next: FeedRowProps): boolean {
  return (
    previous.itemView === next.itemView &&
    previous.areItemPropsEqual === next.areItemPropsEqual &&
    next.areItemPropsEqual(previous, next)
  );
}

export const FeedRow = memo(function FeedRow(props: FeedRowProps) {
  const { animateOnMount, itemView, areItemPropsEqual, ...itemProps } = props;
  void areItemPropsEqual;
  const ItemView = itemView;
  const animate = useRef(animateOnMount).current;
  const { item } = itemProps;
  const isPrompt = item.type === 'message' && item.event.author === 'user';
  const isWideAppResponse =
    item.type === 'message' && item.event.author !== 'user' && hasAppBlock(item.event.text ?? '');
  const rowId = feedRowId(item);
  const reach = useTranscriptReachChrome();
  const reachClass = feedRowReachClassName({
    rowId,
    itemKey: item.key,
    activeRowId: reach.activeRowId,
    matchRowIds: reach.matchRowIds,
    rangeStartKey: reach.rangeStartKey,
    rangeEndKey: reach.rangeEndKey,
  });
  const hit = feedRowHitKind(rowId, reach.activeRowId, reach.matchRowIds);

  return (
    <div
      data-feed-row-id={rowId}
      data-anchor-id={isPrompt ? item.key : undefined}
      data-transcript-find-hit={hit}
      className={`mx-auto min-w-0 ${isWideAppResponse ? 'max-w-4xl' : 'max-w-2xl'} ${
        animate ? 'feed-row-enter' : ''
      } ${reachClass}`}
    >
      {reach.rangeSelecting && (
        <button
          type="button"
          data-testid="transcript-range-row"
          aria-label="Select this row for range copy"
          onClick={() => {
            reach.onSelectRangeRow(item.key);
          }}
          className="mb-1 rounded-md border border-droid-border px-1.5 py-0.5 text-[10px] text-droid-text-muted hover:text-droid-text"
        >
          {rangeRowLabel(item.key, reach.rangeStartKey, reach.rangeEndKey)}
        </button>
      )}
      <ItemView {...itemProps} />
    </div>
  );
}, areFeedRowPropsEqual);

export interface FeedRowsSharedProps {
  pending: boolean;
  cwd?: string;
  onOpenDiff?: (change: FileChange) => void;
  onOpenReviewFile?: (path: string) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  subagentsDock?: SubagentsDockData;
  liveTiming: boolean;
  specContent?: string;
  // Render-only tool-activity settings, applied to every row.
  density: ToolActivityDensity;
  inlineDiffs: boolean;
}

export function optionalFeedRowProps(shared: FeedRowsSharedProps): Partial<FeedItemViewProps> {
  return {
    density: shared.density,
    inlineDiffs: shared.inlineDiffs,
    ...(shared.cwd !== undefined ? { cwd: shared.cwd } : {}),
    ...(shared.onOpenDiff !== undefined ? { onOpenDiff: shared.onOpenDiff } : {}),
    ...(shared.onOpenReviewFile !== undefined ? { onOpenReviewFile: shared.onOpenReviewFile } : {}),
    ...(shared.onOpenChildSession !== undefined
      ? { onOpenChildSession: shared.onOpenChildSession }
      : {}),
    ...(shared.childSessionActivity !== undefined
      ? { childSessionActivity: shared.childSessionActivity }
      : {}),
    ...(shared.subagentsDock !== undefined ? { subagentsDock: shared.subagentsDock } : {}),
    ...(shared.specContent !== undefined ? { specContent: shared.specContent } : {}),
  };
}

function feedRowHitKind(
  rowId: string,
  activeRowId: string | null,
  matchRowIds: ReadonlySet<string>,
): 'active' | 'match' | undefined {
  if (activeRowId === rowId) return 'active';
  if (matchRowIds.has(rowId)) return 'match';
  return undefined;
}

function rangeRowLabel(
  itemKey: string,
  rangeStartKey: string | null,
  rangeEndKey: string | null,
): string {
  if (rangeStartKey === itemKey) return 'Range start';
  if (rangeEndKey === itemKey) return 'Range end';
  return 'Add to range';
}

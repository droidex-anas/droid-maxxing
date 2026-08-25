/* eslint-disable react/prop-types -- TypeScript owns this internal renderer contract. */
import { Fragment, memo, useRef, type ComponentType } from 'react';

import { feedRowId } from '../hooks/conversationViewportAnchor';
import type { ChildSessionActivity, ChildSessionTarget } from '../lib/childSessions';
import type { FileChange } from '../lib/diff';
import type { TranscriptEvent } from '../types/bridge';
import { hasAppBlock } from './appBlockRuntime';
import type { FeedItem, FeedItemViewProps } from './chat';
import type { FinalResponseKeyState } from './messageFeedState';
import type { SubagentsDockData } from './SubagentsDock';
import { WorktreeCreatedCard } from './WorktreeCreatedCard';

const FEED_ROW_RENDER_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 96px',
} as const;

interface FeedRowProps extends FeedItemViewProps {
  animateOnMount: boolean;
  itemView: ComponentType<FeedItemViewProps>;
  areItemPropsEqual: (previous: FeedItemViewProps, next: FeedItemViewProps) => boolean;
}

const FeedRow = memo(
  function FeedRow(props: FeedRowProps) {
    const { animateOnMount, itemView, areItemPropsEqual, ...itemProps } = props;
    void areItemPropsEqual;
    const ItemView = itemView;
    const animate = useRef(animateOnMount).current;
    const { item } = itemProps;
    const isPrompt = item.type === 'message' && item.event.author === 'user';
    const isWideAppResponse =
      item.type === 'message' && item.event.author !== 'user' && hasAppBlock(item.event.text ?? '');

    return (
      <div
        data-feed-row-id={feedRowId(item)}
        data-anchor-id={isPrompt ? item.key : undefined}
        style={FEED_ROW_RENDER_STYLE}
        className={`mx-auto min-w-0 ${isWideAppResponse ? 'max-w-4xl' : 'max-w-2xl'} ${
          animate ? 'feed-row-enter' : ''
        }`}
      >
        <ItemView {...itemProps} />
      </div>
    );
  },
  (previous, next) =>
    previous.itemView === next.itemView &&
    previous.areItemPropsEqual === next.areItemPropsEqual &&
    next.areItemPropsEqual(previous, next),
);

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
}

interface FeedRowsChunkProps {
  items: readonly FeedItem[];
  itemOffset: number;
  lastItemIndex: number;
  isLiveChunk: boolean;
  shared: FeedRowsSharedProps;
  activityRevision: readonly TranscriptEvent[];
  animateKeys: ReadonlySet<string>;
  freshAppResponseTexts: ReadonlySet<string>;
  finalResponseState: FinalResponseKeyState;
  compacting: boolean;
  subagentPoll: boolean;
  worktreeInsertAfter: number;
  createdWorktreePath?: string;
  itemView: ComponentType<FeedItemViewProps>;
  areItemPropsEqual: (previous: FeedItemViewProps, next: FeedItemViewProps) => boolean;
}

const volatileFeedChunks = new WeakMap<readonly FeedItem[], boolean>();

export const FeedRowsChunk = memo(
  function FeedRowsChunk({
    items,
    itemOffset,
    lastItemIndex,
    shared,
    animateKeys,
    freshAppResponseTexts,
    finalResponseState,
    compacting,
    subagentPoll,
    worktreeInsertAfter,
    createdWorktreePath,
    itemView,
    areItemPropsEqual,
  }: FeedRowsChunkProps) {
    const optionalItemProps = optionalFeedRowProps(shared);
    return items.map((item, localIndex) => {
      const index = itemOffset + localIndex;
      return (
        <Fragment key={item.key}>
          <FeedRow
            item={item}
            itemView={itemView}
            areItemPropsEqual={areItemPropsEqual}
            animateOnMount={animateKeys.has(item.key)}
            live={shared.pending && index === lastItemIndex && !subagentPoll}
            autoPlayAppBlocks={
              item.type === 'message' &&
              item.event.author !== 'user' &&
              freshAppResponseTexts.has(item.event.text ?? '')
            }
            sessionLive={shared.pending}
            compacting={compacting && index === lastItemIndex}
            {...optionalItemProps}
            liveTiming={shared.liveTiming}
            isFinalResponse={
              finalResponseState.settledKeys.has(item.key) ||
              finalResponseState.liveKeys.has(item.key)
            }
          />
          {index === worktreeInsertAfter && createdWorktreePath && (
            <div className="mx-auto min-w-0 max-w-2xl">
              <WorktreeCreatedCard path={createdWorktreePath} />
            </div>
          )}
        </Fragment>
      );
    });
  },
  (previous, next) => {
    if (
      previous.items !== next.items ||
      previous.itemOffset !== next.itemOffset ||
      previous.shared !== next.shared ||
      previous.isLiveChunk ||
      next.isLiveChunk ||
      previous.worktreeInsertAfter !== next.worktreeInsertAfter ||
      previous.createdWorktreePath !== next.createdWorktreePath ||
      previous.finalResponseState.settledKeys !== next.finalResponseState.settledKeys ||
      previous.itemView !== next.itemView ||
      previous.areItemPropsEqual !== next.areItemPropsEqual
    ) {
      return false;
    }
    return (
      !feedChunkHasChildActivity(next.items) || previous.activityRevision === next.activityRevision
    );
  },
);

function optionalFeedRowProps(shared: FeedRowsSharedProps): Partial<FeedItemViewProps> {
  return {
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

function feedChunkHasChildActivity(items: readonly FeedItem[]): boolean {
  const cached = volatileFeedChunks.get(items);
  if (cached !== undefined) return cached;
  const hasChildActivity = items.some(feedItemHasChildActivity);
  volatileFeedChunks.set(items, hasChildActivity);
  return hasChildActivity;
}

function feedItemHasChildActivity(item: FeedItem): boolean {
  return (
    item.type === 'child_session' ||
    item.type === 'child_sessions' ||
    (item.type === 'worked' && item.items.some(feedItemHasChildActivity))
  );
}

import { memo, useRef, type ComponentType } from 'react';

import { feedRowId } from '../hooks/conversationViewportAnchor';
import type { ChildSessionActivity, ChildSessionTarget } from '../lib/childSessions';
import type { FileChange } from '../lib/diff';
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

  return (
    <div
      data-feed-row-id={feedRowId(item)}
      data-anchor-id={isPrompt ? item.key : undefined}
      className={`mx-auto min-w-0 ${isWideAppResponse ? 'max-w-4xl' : 'max-w-2xl'} ${
        animate ? 'feed-row-enter' : ''
      }`}
    >
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
}

export function optionalFeedRowProps(shared: FeedRowsSharedProps): Partial<FeedItemViewProps> {
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

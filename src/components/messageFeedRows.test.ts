import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentType } from 'react';

import type { FeedItemViewProps } from './chat';
import type { FeedItem } from './chatFeed';
import { areFeedRowPropsEqual } from './messageFeedRows';
import type { TranscriptEvent } from '../types/bridge';

function messageItem(id: string, author: 'user' | 'assistant'): FeedItem {
  const event: TranscriptEvent = {
    id,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 1,
    kind: 'text',
    author,
    text: id,
  };
  return { type: 'message', key: id, event };
}

const itemView = (() => {}) as unknown as ComponentType<FeedItemViewProps>;
const areItemPropsEqual = (previous: FeedItemViewProps, next: FeedItemViewProps) =>
  previous.item === next.item &&
  previous.live === next.live &&
  previous.isFinalResponse === next.isFinalResponse;

function rowProps(overrides: Partial<Parameters<typeof areFeedRowPropsEqual>[0]> = {}) {
  const item = messageItem('answer-1', 'assistant');
  return {
    item,
    live: false,
    animateOnMount: false,
    itemView,
    areItemPropsEqual,
    isFinalResponse: false,
    ...overrides,
  };
}

test('a row re-renders when its live final-response flag changes', () => {
  const previous = rowProps({ isFinalResponse: true });
  const next = { ...previous, isFinalResponse: false };
  assert.equal(areFeedRowPropsEqual(previous, next), false);
});

test('a settled row skips re-render when only sibling live state is unchanged', () => {
  const previous = rowProps();
  const unchanged = { ...previous };
  assert.equal(areFeedRowPropsEqual(previous, unchanged), true);
});

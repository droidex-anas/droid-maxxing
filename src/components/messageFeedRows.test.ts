import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentType } from 'react';

import type { FeedItem, FeedItemViewProps } from './chat';
import { areFeedRowPropsEqual } from './messageFeedRows';
import { feedRowId } from '../hooks/conversationViewportAnchor';
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

test('row mount identity follows item.key across a sliding capped window', () => {
  const kept = messageItem('item-5', 'assistant');
  const before = [messageItem('item-4', 'user'), kept];
  const after = [kept, messageItem('item-6', 'user')];

  assert.equal(after[0]?.key, before[1]?.key);
  assert.equal(feedRowId(after[0]!), feedRowId(before[1]!));
  assert.notEqual(after[0]?.key, after[1]?.key);
});

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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentType } from 'react';

import { asChunkedSequence, chunkedSequenceChunks } from '../lib/chunkedSequence';
import type { TranscriptEvent } from '../types/bridge';
import type { FeedItem, FeedItemViewProps } from './chat';
import { areFeedRowsChunkPropsEqual, feedRowsChunkKey } from './messageFeedRows';
import type { FinalResponseKeyState } from './messageFeedState';

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

const finalResponseState = (): FinalResponseKeyState => ({
  identity: 'm:primary',
  latestPromptEvent: undefined,
  settledKeys: new Set(['answer-1']),
  liveKeys: new Set(['answer-2']),
});

const itemView = (() => {}) as unknown as ComponentType<FeedItemViewProps>;
const areItemPropsEqual = () => true;

function chunkProps(overrides: Partial<Parameters<typeof areFeedRowsChunkPropsEqual>[0]> = {}) {
  return {
    items: [messageItem('user-1', 'user'), messageItem('answer-1', 'assistant')],
    itemOffset: 0,
    lastItemIndex: 1,
    isLiveChunk: false,
    shared: {
      pending: false,
      liveTiming: true,
    },
    activityRevision: [],
    animateKeys: new Set<string>(),
    freshAppResponseTexts: new Set<string>(),
    finalResponseState: finalResponseState(),
    compacting: false,
    subagentPoll: false,
    worktreeInsertAfter: -1,
    itemView,
    areItemPropsEqual,
    ...overrides,
  };
}

test('chunk keys are positional so a sliding capped window keeps chunk identity', () => {
  const windowSize = 900;
  const items = Array.from({ length: windowSize }, (_, index) =>
    messageItem(`item-${String(index)}`, index % 2 === 0 ? 'user' : 'assistant'),
  );
  const before = chunkedSequenceChunks(asChunkedSequence(items));
  // The capped window drops the oldest event for every newly appended one, so
  // every chunk boundary lands on different content after the slide.
  const after = chunkedSequenceChunks(
    asChunkedSequence([...items.slice(1), messageItem('item-new', 'assistant')]),
  );

  assert.equal(after.length, before.length);
  assert.deepEqual(
    after.map((_, index) => feedRowsChunkKey(index)),
    before.map((_, index) => feedRowsChunkKey(index)),
  );
  assert.notEqual(after[0]?.[0]?.key, before[0]?.[0]?.key);
});

test('chunk comparison re-renders when only the live final-response key set changes', () => {
  const previous = chunkProps();
  const liveKeysChanged = {
    ...previous,
    finalResponseState: {
      ...previous.finalResponseState,
      settledKeys: previous.finalResponseState.settledKeys,
      liveKeys: new Set(['answer-3']),
    },
  };

  assert.equal(
    previous.finalResponseState.settledKeys,
    liveKeysChanged.finalResponseState.settledKeys,
  );
  assert.equal(areFeedRowsChunkPropsEqual(previous, liveKeysChanged), false);
});

test('chunk comparison still skips chunks whose final-response state is unchanged', () => {
  const previous = chunkProps();
  const unchanged = {
    ...previous,
    finalResponseState: { ...previous.finalResponseState },
  };

  assert.equal(previous.finalResponseState.settledKeys, unchanged.finalResponseState.settledKeys);
  assert.equal(previous.finalResponseState.liveKeys, unchanged.finalResponseState.liveKeys);
  assert.equal(areFeedRowsChunkPropsEqual(previous, unchanged), true);
});

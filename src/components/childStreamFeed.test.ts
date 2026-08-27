import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptEvent } from '../types/bridge';
import { feedRowId } from '../hooks/conversationViewportAnchor';
import { applyConversationContentResize } from '../hooks/useConversationScrollWindow';
import { sameFeedEvents, feedItemPropsEqual, type FeedItemViewProps } from './chat';
import type { FeedItem } from './chatFeed';
import { createChatFeedProjector, type ChatFeedProjectorInput } from './chatFeedProjector';
import { getRendererPerfSnapshot, resetRendererPerfForTest } from '../lib/rendererPerf';
import type { TranscriptMutation } from '../lib/transcriptMutation';
import type { ChildSessionSummary } from '../types/bridge';
import { childStreamSnapshot } from '../lib/childSessionStream';

function event(id: string, overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    id,
    appSessionId: 'session-a',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    author: 'assistant',
    text: id,
    ts: 1,
    ...overrides,
  };
}

function user(id: string, ts: number): TranscriptEvent {
  return event(id, { sourceSessionId: 'user', author: 'user', text: id, ts });
}

function spawn(toolUseId: string, ts: number): TranscriptEvent {
  return event(`spawn-${toolUseId}`, {
    kind: 'tool_call',
    toolName: 'Task',
    toolUseId,
    toolArgs: { subagent_type: toolUseId, description: `${toolUseId} work` },
    ts,
    author: undefined,
    text: undefined,
  });
}

function appendMutation(
  revision: number,
  previousLength: number,
  firstChangedIndex: number,
): TranscriptMutation {
  return {
    revision,
    baseRevision: revision - 1,
    kind: 'append',
    previousLength,
    firstChangedIndex,
  };
}

function projectorInput(
  allTranscript: TranscriptEvent[],
  transcriptMutation: TranscriptMutation | undefined,
): ChatFeedProjectorInput {
  return {
    conversationKey: 'session-a:primary',
    allTranscript,
    transcriptMutation,
    childSessionId: null,
    pending: true,
    options: { childSessionCards: true, groupChildSessions: true, changes: true },
  };
}

function childItem(key: string, events: TranscriptEvent[]): FeedItem {
  return { type: 'child_sessions', key, events };
}

function messageItem(eventRef: TranscriptEvent): FeedItem {
  return { type: 'message', key: eventRef.id, event: eventRef };
}

function viewProps(item: FeedItem, overrides: Partial<FeedItemViewProps> = {}): FeedItemViewProps {
  return {
    item,
    live: false,
    sessionLive: true,
    ...overrides,
  };
}

test('a streaming child update does not rebuild the parent feed', () => {
  resetRendererPerfForTest();
  const project = createChatFeedProjector();
  const initial = [
    user('user-1', 1),
    event('answer-1', { ts: 2 }),
    spawn('t1', 3),
    spawn('t2', 4),
    spawn('t3', 5),
    spawn('t4', 6),
  ];
  const first = project(projectorInput(initial, undefined));
  assert.equal(first.mode, 'full');

  let events = initial;
  let revision = 0;
  for (const childId of ['child-a', 'child-b', 'child-c', 'child-d']) {
    for (let token = 0; token < 8; token += 1) {
      const previousLength = events.length;
      events = [
        ...events,
        event(`${childId}-${String(token)}`, {
          sourceSessionId: childId,
          role: 'worker',
          ts: events.length + 1,
          text: `token ${String(token)}`,
        }),
      ];
      revision += 1;
      const next = project(
        projectorInput(events, appendMutation(revision, previousLength, previousLength)),
      );
      assert.notEqual(next.mode, 'full');
      assert.equal(next.feedItems, first.feedItems);
    }
  }

  const metrics = getRendererPerfSnapshot();
  assert.equal(metrics.feedProjection.fullBuilds, 1);
  assert.equal(revision, 32);
  assert.ok(metrics.feedProjection.invisibleAppendHits >= 4);
});

test('feedItemPropsEqual isolates a child_sessions card from sibling feed rows', () => {
  const spawnEvent = spawn('t1', 3);
  const userEvent = user('user-1', 1);
  const wave = childItem('child-sessions-t1', [spawnEvent]);
  const dock = { sessions: [] as ChildSessionSummary[], models: [] };
  const previousWave = viewProps(wave, { subagentsDock: dock });
  const nextWave = viewProps(wave, { subagentsDock: dock });
  assert.equal(sameFeedEvents(wave, wave), true);
  assert.equal(feedItemPropsEqual(previousWave, nextWave), true);

  const nextDock = { sessions: [] as ChildSessionSummary[], models: [] };
  assert.equal(
    feedItemPropsEqual(previousWave, viewProps(wave, { subagentsDock: nextDock })),
    false,
  );

  const previousMessage = viewProps(messageItem(userEvent));
  const nextMessage = viewProps(messageItem(userEvent), { sessionLive: true });
  assert.equal(feedItemPropsEqual(previousMessage, nextMessage), true);
});

test('expanding a child preview preserves the parent viewport anchor', () => {
  const items: FeedItem[] = [
    messageItem(user('user-1', 1)),
    childItem('child-sessions-t1', [spawn('t1', 2)]),
    messageItem(event('answer-1', { ts: 3 })),
  ];
  const starts = [0, 120, 200];
  const element = { scrollTop: 80, scrollHeight: 400 } as HTMLDivElement;
  const layout = {
    rowContentOffset: (rowId: string) => {
      const index = items.findIndex((item) => feedRowId(item) === rowId);
      return index >= 0 ? starts[index] : undefined;
    },
  };
  const anchorItem = items[2];
  assert.ok(anchorItem);
  const capturedOffset = starts[2] - element.scrollTop;
  starts[1] += 180;
  starts[2] += 180;
  const restored = applyConversationContentResize(
    element,
    {
      rowId: feedRowId(anchorItem),
      rowOffsetTop: capturedOffset,
      scrollTop: 80,
      scrollHeight: 400,
    },
    false,
    true,
    layout,
  );
  assert.equal(restored.mode, 'preserve-anchor');
  assert.equal(restored.didFindRow, true);
  assert.equal(starts[2] - element.scrollTop, capturedOffset);
});

test('childStreamSnapshot identity is what feed isolation compares through the dock object', () => {
  const session: ChildSessionSummary = {
    parentAppSessionId: 'session-a',
    childSessionId: 'child-a',
    role: 'worker',
    status: 'running',
    modelId: 'droid-core',
    transcriptAvailable: true,
    spawnLink: { kind: 'tool-use', id: 't1' },
    startedAt: 1,
    streamFidelity: 'token',
  };
  const first = childStreamSnapshot(session, {
    status: 'running',
    latest: { kind: 'text', text: 'one' },
  });
  const same = childStreamSnapshot(session, {
    status: 'running',
    latest: { kind: 'text', text: 'one' },
  });
  const grown = childStreamSnapshot(session, {
    status: 'running',
    latest: { kind: 'text', text: 'one two' },
  });
  assert.equal(first.preview === same.preview, true);
  assert.equal(first.preview === grown.preview, false);
});

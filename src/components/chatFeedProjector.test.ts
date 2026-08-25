import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptMutation } from '../lib/transcriptMutation';
import { transcriptForVisibleSession } from '../lib/childSessions';
import { getRendererPerfSnapshot, resetRendererPerfForTest } from '../lib/rendererPerf';
import type { TranscriptEvent } from '../types/bridge';
import { feedRowId } from '../hooks/conversationViewportAnchor';
import { buildGroupedFeed, type GroupedFeedOptions } from './chat';
import {
  CHAT_FEED_WARM_CACHE_MAX_RETAINED_COST,
  CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS,
  createChatFeedProjector,
  type ChatFeedProjection,
  type ChatFeedProjectorInput,
} from './chatFeedProjector';

const PRIMARY_OPTIONS: GroupedFeedOptions = {
  childSessionCards: true,
  changes: true,
  groupChildSessions: true,
};

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

function prependMutation(
  revision: number,
  previousLength: number,
  insertedCount: number,
  firstChangedIndex = 0,
): TranscriptMutation {
  return {
    revision,
    baseRevision: revision - 1,
    kind: 'prepend',
    previousLength,
    firstChangedIndex,
    insertedCount,
  };
}

function input(
  allTranscript: TranscriptEvent[],
  transcriptMutation: TranscriptMutation | undefined,
  overrides: Partial<ChatFeedProjectorInput> = {},
): ChatFeedProjectorInput {
  return {
    conversationKey: 'session-a:primary',
    allTranscript,
    transcriptMutation,
    childSessionId: null,
    pending: true,
    options: PRIMARY_OPTIONS,
    retainedCost: 0,
    ...overrides,
  };
}

function assertMatchesFullBuild(
  projection: ChatFeedProjection,
  projectorInput: ChatFeedProjectorInput,
): void {
  const visible = transcriptForVisibleSession(
    projectorInput.allTranscript,
    projectorInput.childSessionId,
  );
  const feed = buildGroupedFeed(visible, projectorInput.pending, projectorInput.options);
  assert.deepEqual(projection.visibleTranscript, visible);
  assert.deepEqual(projection.feedItems, feed);
  assert.deepEqual(
    projection.feedItems.map((item) => item.key),
    feed.map((item) => item.key),
  );
  assert.deepEqual(projection.feedItems.map(feedRowId), feed.map(feedRowId));
}

test('incremental projection rebuilds one safe turn and preserves completed prefix items', () => {
  const project = createChatFeedProjector();
  const firstTurn = [user('user-1', 1), event('answer-1', { ts: 2 })];
  const toolCall = event('tool-call', {
    kind: 'tool_call',
    author: undefined,
    text: undefined,
    toolUseId: 'tool-use-1',
    toolName: 'Read',
    toolArgs: { path: '/tmp/file' },
    ts: 4,
  });
  const initialEvents = [...firstTurn, user('user-2', 3), toolCall];
  const initialInput = input(initialEvents, undefined);
  const initial = project(initialInput);
  assert.equal(initial.mode, 'full');
  assertMatchesFullBuild(initial, initialInput);

  const result = event('tool-result', {
    kind: 'tool_result',
    author: undefined,
    toolUseId: 'tool-use-1',
    text: 'contents',
    ts: 5,
  });
  const resultEvents = [...initialEvents, result];
  const resultInput = input(resultEvents, appendMutation(1, initialEvents.length, 4));
  const withResult = project(resultInput);

  assert.equal(withResult.mode, 'incremental');
  assert.equal(withResult.rebuiltFromVisibleIndex, 2);
  assert.equal(withResult.feedItems[0], initial.feedItems[0]);
  assert.equal(withResult.feedItems[1], initial.feedItems[1]);
  assertMatchesFullBuild(withResult, resultInput);

  const answer = event('answer-2', { text: 'A', ts: 6 });
  const answerEvents = [...resultEvents, answer];
  const answerInput = input(answerEvents, appendMutation(2, resultEvents.length, 5));
  const withAnswer = project(answerInput);
  assert.equal(withAnswer.mode, 'incremental');
  assertMatchesFullBuild(withAnswer, answerInput);

  const mergedAnswer = { ...answer, text: 'AB', endTs: 7 };
  const mergedEvents = [...resultEvents, mergedAnswer];
  const mergedInput = input(mergedEvents, appendMutation(3, answerEvents.length, 5));
  const withMergedAnswer = project(mergedInput);
  assert.equal(withMergedAnswer.mode, 'incremental');
  assert.equal(withMergedAnswer.rebuiltFromVisibleIndex, 2);
  assertMatchesFullBuild(withMergedAnswer, mergedInput);

  const nextPromptEvents = [...mergedEvents, user('user-3', 8)];
  const nextPromptInput = input(
    nextPromptEvents,
    appendMutation(4, mergedEvents.length, mergedEvents.length),
  );
  const withNextPrompt = project(nextPromptInput);
  assert.equal(withNextPrompt.mode, 'incremental');
  assert.equal(withNextPrompt.rebuiltFromVisibleIndex, 2);
  assertMatchesFullBuild(withNextPrompt, nextPromptInput);
});

test('cross-turn tool results rewind to the correlated call before rebuilding', () => {
  const project = createChatFeedProjector();
  const call = event('grep-call', {
    kind: 'tool_call',
    author: undefined,
    text: undefined,
    toolUseId: 'grep-1',
    toolName: 'Grep',
    toolArgs: { pattern: 'needle' },
    ts: 2,
  });
  const initialEvents = [
    user('user-1', 1),
    call,
    event('answer-1', { ts: 3 }),
    user('user-2', 4),
    event('answer-2', { ts: 5 }),
  ];
  project(input(initialEvents, undefined));
  const result = event('grep-result', {
    kind: 'tool_result',
    author: undefined,
    toolUseId: 'grep-1',
    text: 'needle:1',
    ts: 6,
  });
  const resultEvents = [...initialEvents, result];
  const resultInput = input(
    resultEvents,
    appendMutation(1, initialEvents.length, initialEvents.length),
  );

  const projection = project(resultInput);

  assert.equal(projection.mode, 'incremental');
  assert.equal(projection.rebuiltFromVisibleIndex, 0);
  assertMatchesFullBuild(projection, resultInput);
});

test('tool-call tail replacement and grouped orchestration stay full-build equivalent', () => {
  const project = createChatFeedProjector();
  const partialTask = event('task-call', {
    kind: 'tool_call',
    author: undefined,
    text: undefined,
    toolUseId: 'task-1',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    ts: 2,
  });
  const initialEvents = [user('user-1', 1), partialTask];
  project(input(initialEvents, undefined));

  const completeTask = {
    ...partialTask,
    toolArgs: { subagent_type: 'worker', description: 'Inspect the runtime' },
    endTs: 3,
  };
  let events = [initialEvents[0], completeTask];
  let revision = 1;
  let projectorInput = input(events, appendMutation(revision, initialEvents.length, 1));
  let projection = project(projectorInput);
  assertMatchesFullBuild(projection, projectorInput);

  const appended = [
    event('todo-call', {
      kind: 'tool_call',
      author: undefined,
      text: undefined,
      toolUseId: 'todo-1',
      toolName: 'TodoWrite',
      toolArgs: { todos: '1. [in_progress] inspect' },
      ts: 4,
    }),
    event('write-call', {
      kind: 'tool_call',
      author: undefined,
      text: undefined,
      toolUseId: 'write-1',
      toolName: 'Write',
      toolArgs: { file_path: '/tmp/result.ts', content: 'export {}' },
      ts: 5,
    }),
    event('task-call-2', {
      kind: 'tool_call',
      author: undefined,
      text: undefined,
      toolUseId: 'task-2',
      toolName: 'Task',
      toolArgs: { subagent_type: 'validator', description: 'Validate the result' },
      ts: 6,
    }),
    event('write-result', {
      kind: 'tool_result',
      author: undefined,
      toolUseId: 'write-1',
      text: 'wrote file',
      ts: 7,
    }),
    event('answer', { text: 'Done', ts: 8 }),
  ];

  for (const nextEvent of appended) {
    const previousLength = events.length;
    events = [...events, nextEvent];
    revision += 1;
    projectorInput = input(events, appendMutation(revision, previousLength, previousLength));
    projection = project(projectorInput);
    assert.equal(projection.mode, 'incremental');
    assertMatchesFullBuild(projection, projectorInput);
  }
});

test('invisible child and sibling appends retain exact visible and feed references', () => {
  const primaryProject = createChatFeedProjector();
  const initial = [
    user('user-1', 1),
    event('answer-1', { ts: 2 }),
    event('child-a-1', {
      sourceSessionId: 'child-a',
      role: 'worker',
      ts: 3,
    }),
  ];
  const primaryInput = input(initial, undefined);
  const primary = primaryProject(primaryInput);
  const childAppend = event('child-a-2', {
    sourceSessionId: 'child-a',
    role: 'worker',
    ts: 4,
  });
  const nextPrimaryInput = input(
    [...initial, childAppend],
    appendMutation(1, initial.length, initial.length),
  );
  const nextPrimary = primaryProject(nextPrimaryInput);

  assert.equal(nextPrimary.mode, 'incremental');
  assert.equal(nextPrimary.visibleTranscript, primary.visibleTranscript);
  assert.equal(nextPrimary.feedItems, primary.feedItems);
  assertMatchesFullBuild(nextPrimary, nextPrimaryInput);

  const childProject = createChatFeedProjector();
  const childInput = input(initial, undefined, {
    conversationKey: 'session-a:child-a',
    childSessionId: 'child-a',
    options: { ...PRIMARY_OPTIONS, groupChildSessions: false },
  });
  const child = childProject(childInput);
  const siblingAppend = event('child-b-1', {
    sourceSessionId: 'child-b',
    role: 'validator',
    ts: 5,
  });
  const nextChildInput = input(
    [...initial, siblingAppend],
    appendMutation(1, initial.length, initial.length),
    {
      conversationKey: 'session-a:child-a',
      childSessionId: 'child-a',
      options: { ...PRIMARY_OPTIONS, groupChildSessions: false },
    },
  );
  const nextChild = childProject(nextChildInput);

  assert.equal(nextChild.visibleTranscript, child.visibleTranscript);
  assert.equal(nextChild.feedItems, child.feedItems);
  assertMatchesFullBuild(nextChild, nextChildInput);
});

test('production projection paths report exact rebuild and reuse metrics', () => {
  resetRendererPerfForTest();
  const project = createChatFeedProjector();
  const initial = [
    user('user-1', 1),
    event('answer-1', { ts: 2 }),
    user('user-2', 3),
    event('answer-2', { ts: 4 }),
  ];
  const initialInput = input(initial, undefined);

  project(initialInput);
  project(initialInput);

  const visibleAppend = [...initial, event('answer-3', { ts: 5 })];
  project(input(visibleAppend, appendMutation(1, initial.length, initial.length)));

  const childAppend = event('child-a-1', {
    sourceSessionId: 'child-a',
    role: 'worker',
    ts: 6,
  });
  project(
    input(
      [...visibleAppend, childAppend],
      appendMutation(2, visibleAppend.length, visibleAppend.length),
    ),
  );

  const metrics = getRendererPerfSnapshot().feedProjection;
  assert.equal(metrics.fullBuilds, 1);
  assert.equal(metrics.incrementalBuilds, 1);
  assert.equal(metrics.cacheHits, 1);
  assert.equal(metrics.invisibleAppendHits, 1);
  assert.equal(metrics.eventsRebuilt, 7);
  assert.equal(metrics.eventsReused, 11);
  assert.equal(metrics.durationMs.count, 4);
});

test('uncertain provenance and semantic option changes use the full-build oracle', () => {
  const project = createChatFeedProjector();
  const initialEvents = [user('user-1', 1), event('answer-1', { ts: 2 })];
  const initialInput = input(initialEvents, undefined);
  project(initialInput);

  const appended = [...initialEvents, event('answer-2', { ts: 3 })];
  const missedRevisionInput = input(appended, {
    ...appendMutation(2, initialEvents.length, initialEvents.length),
    baseRevision: 1,
  });
  const missedRevision = project(missedRevisionInput);
  assert.equal(missedRevision.mode, 'full');
  assert.equal(missedRevision.rebuiltFromVisibleIndex, 0);
  assertMatchesFullBuild(missedRevision, missedRevisionInput);

  const resetEvents = [event('older', { ts: 0 }), ...appended];
  const resetInput = input(resetEvents, {
    revision: 3,
    baseRevision: 2,
    kind: 'reset',
    previousLength: appended.length,
    firstChangedIndex: 0,
  });
  const reset = project(resetInput);
  assert.equal(reset.mode, 'full');
  assertMatchesFullBuild(reset, resetInput);

  const settledInput = { ...resetInput, pending: false };
  const settled = project(settledInput);
  assert.equal(settled.mode, 'full');
  assertMatchesFullBuild(settled, settledInput);

  const specInput = {
    ...settledInput,
    options: { ...PRIMARY_OPTIONS, specContent: '# Revised specification' },
  };
  const withSpec = project(specInput);
  assert.equal(withSpec.mode, 'full');
  assertMatchesFullBuild(withSpec, specInput);
});

test('recent conversations restore their exact derived feed from the warm cache', () => {
  const project = createChatFeedProjector();
  const sessionA = input([user('user-a', 1), event('answer-a', { ts: 2 })], undefined);
  const sessionB = input(
    [user('user-b', 1), event('answer-b', { appSessionId: 'session-b', text: 'B', ts: 2 })],
    undefined,
    { conversationKey: 'session-b:primary' },
  );
  const sessionC = input(
    [user('user-c', 1), event('answer-c', { appSessionId: 'session-c', text: 'C', ts: 2 })],
    undefined,
    { conversationKey: 'session-c:primary' },
  );
  const firstA = project(sessionA);
  project(sessionB);
  project(sessionC);

  const restoredA = project(sessionA);

  assert.equal(restoredA.visibleTranscript, firstA.visibleTranscript);
  assert.equal(restoredA.feedItems, firstA.feedItems);
  assert.deepEqual(restoredA.feedItems.map(feedRowId), firstA.feedItems.map(feedRowId));
});

test('warm conversation caching is count- and transcript-bounded', () => {
  const project = createChatFeedProjector();
  const forSession = (id: string, count = 2) =>
    input(
      Array.from({ length: count }, (_, index) =>
        event(`${id}-${String(index)}`, {
          appSessionId: id,
          author: index === 0 ? 'user' : 'assistant',
          sourceSessionId: index === 0 ? 'user' : 'primary',
          ts: index,
        }),
      ),
      undefined,
      { conversationKey: `${id}:primary` },
    );

  const firstA = project(forSession('session-a'));
  project(forSession('session-b'));
  project(forSession('session-c'));
  project(forSession('session-d'));
  const evictedA = project(forSession('session-a'));
  assert.notEqual(evictedA.feedItems, firstA.feedItems);

  const large = forSession('large', CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS + 1);
  const firstLarge = project(large);
  project(forSession('other'));
  const rebuiltLarge = project(large);
  assert.notEqual(rebuiltLarge.feedItems, firstLarge.feedItems);

  const interleavedSource = [
    ...Array.from({ length: CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS + 1 }, (_, index) =>
      event(`primary-${String(index)}`, { ts: index }),
    ),
    event('only-child-row', {
      sourceSessionId: 'small-child',
      role: 'worker',
      ts: CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS + 1,
    }),
  ];
  const childOverLargeParent = input(interleavedSource, undefined, {
    conversationKey: 'large-parent:small-child',
    childSessionId: 'small-child',
    options: { ...PRIMARY_OPTIONS, groupChildSessions: false },
  });
  const firstChild = project(childOverLargeParent);
  project(forSession('after-child'));
  const rebuiltChild = project(childOverLargeParent);
  assert.notEqual(rebuiltChild.feedItems, firstChild.feedItems);

  const oversizedPayload = input([user('payload-user', 1)], undefined, {
    conversationKey: 'oversized-payload:primary',
    retainedCost: CHAT_FEED_WARM_CACHE_MAX_RETAINED_COST + 1,
  });
  const firstPayload = project(oversizedPayload);
  project(forSession('after-payload'));
  const rebuiltPayload = project(oversizedPayload);
  assert.notEqual(rebuiltPayload.feedItems, firstPayload.feedItems);
});

test('long-history appends rebuild only the final turn', () => {
  const project = createChatFeedProjector();
  const turnCount = 5_000;
  let eventIdReads = 0;
  const tracked = (item: TranscriptEvent): TranscriptEvent => {
    const id = item.id;
    Object.defineProperty(item, 'id', {
      configurable: true,
      enumerable: true,
      get: () => {
        eventIdReads += 1;
        return id;
      },
    });
    return item;
  };
  const history = Array.from({ length: turnCount }, (_, turn) => [
    tracked(user(`user-${String(turn)}`, turn * 2)),
    tracked(event(`answer-${String(turn)}`, { ts: turn * 2 + 1 })),
  ]).flat();
  const initial = project(input(history, undefined, { pending: false }));
  eventIdReads = 0;
  const appended = event('tail-status', {
    kind: 'status',
    author: undefined,
    text: 'Finishing',
    ts: history.length,
  });
  const nextInput = input(
    [...history, appended],
    appendMutation(1, history.length, history.length),
    { pending: false },
  );

  const next = project(nextInput);

  assert.equal(next.mode, 'incremental');
  assert.equal(next.updateKind, 'append');
  assert.equal(next.rebuiltFromVisibleIndex, history.length - 2);
  assert.ok(eventIdReads < 20, `expected a tail lookup, observed ${String(eventIdReads)} ID reads`);
  assert.equal(next.feedItems[0], initial.feedItems[0]);
  assert.equal(next.feedItems[initial.feedItems.length - 3], initial.feedItems.at(-3));
  assertMatchesFullBuild(next, nextInput);
});

test('long-history prepends build only the older page and retain the existing feed suffix', () => {
  const project = createChatFeedProjector();
  const existing = Array.from({ length: 2_000 }, (_, turn) => [
    user(`recent-user-${String(turn)}`, turn * 2 + 4_000),
    event(`recent-answer-${String(turn)}`, { ts: turn * 2 + 4_001 }),
  ]).flat();
  const initial = project(input(existing, undefined, { pending: false }));
  const older = Array.from({ length: 800 }, (_, turn) => [
    user(`older-user-${String(turn)}`, turn * 2),
    event(`older-answer-${String(turn)}`, { ts: turn * 2 + 1 }),
  ]).flat();
  const prepended = [...older, ...existing];
  const nextInput = input(prepended, prependMutation(1, existing.length, older.length), {
    pending: false,
  });

  const next = project(nextInput);

  assert.equal(next.mode, 'incremental');
  assert.equal(next.updateKind, 'prepend');
  assert.equal(next.reusedVisibleEventCount, existing.length);
  assert.equal(next.feedItems.at(-1), initial.feedItems.at(-1));
  assert.equal(next.feedItems.at(-500), initial.feedItems.at(-500));
  assertMatchesFullBuild(next, nextInput);
});

test('a visible prepend without a safe user-turn boundary falls back to the full oracle', () => {
  const project = createChatFeedProjector();
  const existing = [
    event('tool-call', {
      kind: 'tool_call',
      author: undefined,
      text: undefined,
      toolName: 'Read',
      toolUseId: 'read-1',
    }),
    event('tool-result', {
      kind: 'tool_result',
      author: undefined,
      toolUseId: 'read-1',
    }),
  ];
  project(input(existing, undefined, { pending: false }));
  const older = [event('older-status', { kind: 'status', author: undefined })];
  const nextInput = input(
    [...older, ...existing],
    prependMutation(1, existing.length, older.length),
    { pending: false },
  );

  const next = project(nextInput);

  assert.equal(next.mode, 'full');
  assertMatchesFullBuild(next, nextInput);
});

test('a prepend with tool correlation across the reuse boundary falls back to the full oracle', () => {
  const project = createChatFeedProjector();
  const result = event('read-result', {
    kind: 'tool_result',
    author: undefined,
    toolUseId: 'cross-page-read',
    ts: 4,
  });
  const existing = [user('recent-user', 3), result, event('recent-answer', { ts: 5 })];
  project(input(existing, undefined, { pending: false }));
  const older = [
    user('older-user', 1),
    event('read-call', {
      kind: 'tool_call',
      author: undefined,
      text: undefined,
      toolName: 'Read',
      toolUseId: 'cross-page-read',
      ts: 2,
    }),
  ];
  const nextInput = input(
    [...older, ...existing],
    prependMutation(1, existing.length, older.length),
    { pending: false },
  );

  const next = project(nextInput);

  assert.equal(next.mode, 'full');
  assertMatchesFullBuild(next, nextInput);
});

test('prepend lookahead preserves thinking duration at the retained user boundary', () => {
  const project = createChatFeedProjector();
  const existing = [user('recent-user', 10), event('recent-answer', { ts: 11 })];
  project(input(existing, undefined, { pending: false }));
  const older = [
    user('older-user', 1),
    event('older-thinking', { kind: 'thinking', author: undefined, ts: 4 }),
  ];
  const nextInput = input(
    [...older, ...existing],
    prependMutation(1, existing.length, older.length),
    { pending: false },
  );

  const next = project(nextInput);

  assert.equal(next.mode, 'incremental');
  assertMatchesFullBuild(next, nextInput);
});

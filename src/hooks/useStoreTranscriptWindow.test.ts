import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptRehydrationLimit } from '../lib/transcriptStoreMemory';
import { estimateTranscriptCost } from '../lib/transcriptWindow';
import type { ChildSessionSummary, SessionSummary, TranscriptEvent } from '../types/bridge';
import { initialState, reducer, type AppState } from './useStore';

function session(appSessionId: string, streaming = false): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '/tmp',
    autonomy: 'off',
    phase: 'running',
    streaming,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function events(appSessionId: string, count: number): TranscriptEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${appSessionId}-${index}`,
    appSessionId,
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text: `event ${index} ${'payload '.repeat(16)}`,
    ts: index,
    ...(index % 100 === 0 ? { author: 'user' as const } : {}),
  }));
}

function childSession(
  parentAppSessionId: string,
  childSessionId: string,
  role: 'worker' | 'validator' = 'worker',
): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role,
    status: 'completed',
    modelId: 'model',
    transcriptAvailable: true,
    streamFidelity: 'state',
  };
}

function stateWithTranscript(
  appSessionId: string,
  transcript: TranscriptEvent[],
  overrides: Partial<AppState> = {},
): AppState {
  return {
    ...initialState,
    sessions: { [appSessionId]: session(appSessionId) },
    sessionOrder: [appSessionId],
    activeAppSessionId: appSessionId,
    transcripts: { [appSessionId]: transcript },
    transcriptRetainedCost: {
      [appSessionId]: estimateTranscriptCost(transcript),
    },
    transcriptViewportPinned: { [appSessionId]: true },
    historyLoaded: { [appSessionId]: true },
    sessionRestore: {
      [appSessionId]: {
        status: 'loaded',
        loadedCount: transcript.length,
        hasMore: false,
      },
    },
    ...overrides,
  };
}

test('viewport release removes only old in-memory events after a settled bottom-pinned turn', () => {
  const transcript = events('active', 4_000);
  const state = stateWithTranscript('active', transcript, {
    historyCursor: { active: 'stale-before-release' },
    transcriptMutations: {
      active: {
        revision: 7,
        baseRevision: 6,
        kind: 'append',
        previousLength: 3_999,
        firstChangedIndex: 3_999,
      },
    },
  });

  const next = reducer(state, {
    type: 'TRANSCRIPT_RELEASE_VIEWPORT',
    appSessionId: 'active',
  });

  assert.ok(next.transcripts.active.length < transcript.length);
  assert.equal(next.transcripts.active.at(-1)?.id, transcript.at(-1)?.id);
  assert.equal(next.historyLoaded.active, false);
  assert.equal(next.historyCursor.active, undefined);
  assert.equal(next.sessionRestore.active?.status, 'paged');
  assert.equal(next.sessionRestore.active?.hasMore, true);
  assert.deepEqual(next.transcriptMutations.active, {
    revision: 8,
    baseRevision: 7,
    kind: 'reset',
    previousLength: transcript.length,
    firstChangedIndex: 0,
  });
  assert.equal(
    transcriptRehydrationLimit(next.sessionRestore.active),
    next.transcripts.active.length,
  );
});

test('exact older-history insertion records prepend provenance', () => {
  const transcript = events('active', 2);
  const state = stateWithTranscript('active', transcript, {
    transcriptMutations: {
      active: {
        revision: 3,
        baseRevision: 2,
        kind: 'append',
        previousLength: 1,
        firstChangedIndex: 1,
      },
    },
  });
  const older = events('active', 1).map((event) => ({ ...event, id: 'older', ts: -1 }));

  const next = reducer(state, {
    type: 'SESSION_HISTORY',
    appSessionId: 'active',
    progress: [],
    transcripts: older,
    mode: 'prepend',
  });

  assert.deepEqual(next.transcriptMutations.active, {
    revision: 4,
    baseRevision: 3,
    kind: 'prepend',
    previousLength: transcript.length,
    firstChangedIndex: 0,
    insertedCount: 1,
  });
});

test('primary release preserves child-session transcripts owned by separate history', () => {
  const primary = events('active', 4_000);
  const childEvents: TranscriptEvent[] = Array.from({ length: 500 }, (_, index) => ({
    id: `child-${index}`,
    appSessionId: 'active',
    sourceSessionId: 'child-1',
    role: 'worker',
    kind: 'text',
    text: `child event ${index}`,
    ts: index + 0.5,
  }));
  const transcript = primary.flatMap((event, index) =>
    index < childEvents.length ? [event, childEvents[index]] : [event],
  );

  const next = reducer(stateWithTranscript('active', transcript), {
    type: 'TRANSCRIPT_RELEASE_VIEWPORT',
    appSessionId: 'active',
  });

  assert.ok(next.transcripts.active.length < transcript.length);
  assert.deepEqual(
    next.transcripts.active.filter((event) => event.role === 'worker').map((event) => event.id),
    childEvents.map((event) => event.id),
  );
});

test('emergency release bounds aggregate memory across many smaller child transcripts', () => {
  const childSessions: Record<string, ChildSessionSummary> = {};
  const childHistory: AppState['childHistory']['active'] = {};
  const transcript: TranscriptEvent[] = [];
  for (let childIndex = 0; childIndex < 80; childIndex += 1) {
    const childSessionId = `child-${childIndex}`;
    childSessions[childSessionId] = childSession('active', childSessionId);
    childHistory[childSessionId] = {
      status: 'loaded',
      loadedCount: 400,
      hasMore: false,
      isLoaded: true,
      isLoadingOlder: false,
      isViewportPinned: true,
    };
    for (let eventIndex = 0; eventIndex < 400; eventIndex += 1) {
      transcript.push({
        id: `${childSessionId}-${eventIndex}`,
        appSessionId: 'active',
        sourceSessionId: childSessionId,
        role: 'worker',
        kind: 'text',
        text: `child event ${eventIndex}`,
        ts: childIndex * 1_000 + eventIndex,
      });
    }
  }
  const state = stateWithTranscript('active', transcript, {
    childSessions: { active: childSessions },
    childHistory: { active: childHistory },
  });

  const actions = [
    {
      type: 'SESSION_TRANSCRIPT' as const,
      event: {
        id: 'child-0-live',
        appSessionId: 'active',
        sourceSessionId: 'child-0',
        role: 'worker' as const,
        kind: 'text' as const,
        author: 'assistant' as const,
        text: 'live tail',
        ts: 100_000,
      },
    },
    {
      type: 'SESSION_TRANSCRIPT' as const,
      event: {
        id: 'child-1-live',
        appSessionId: 'active',
        sourceSessionId: 'child-1',
        role: 'worker' as const,
        kind: 'text' as const,
        author: 'assistant' as const,
        text: 'second live tail',
        ts: 100_001,
      },
    },
  ];
  const sequential = actions.reduce(reducer, state);
  const next = reducer(state, { type: 'BATCH', actions });

  assert.deepEqual(
    { ...next, transcriptMutations: {} },
    { ...sequential, transcriptMutations: {} },
  );
  assert.equal(next.transcriptMutations.active.kind, 'reset');
  assert.equal(next.transcriptMutations.active.baseRevision, 0);
  // The first event crosses the ceiling and releases to the target; the second
  // then remains live on that retained tail until the ceiling is reached again.
  assert.ok(next.transcripts.active.length <= 1_201);
  for (const childSessionId of Object.keys(childSessions)) {
    const retained = next.transcripts.active.filter(
      (event) => event.sourceSessionId === childSessionId,
    );
    assert.ok(retained.length <= (childSessionId === 'child-1' ? 16 : 15));
    assert.equal(next.childHistory.active[childSessionId].status, 'paged');
    assert.equal(next.childHistory.active[childSessionId].isLoaded, false);
  }
  assert.equal(
    next.transcripts.active.some((event) => event.id === 'child-0-live'),
    true,
  );
  assert.equal(
    next.transcripts.active.some((event) => event.id === 'child-1-live'),
    true,
  );
});

test('primary history prepends still enforce the emergency transcript budget', () => {
  const fullTranscript = events('active', 33_000);
  const existing = fullTranscript.slice(2_000);
  const olderPage = fullTranscript.slice(0, 2_000);
  const state = stateWithTranscript('active', existing);

  const next = reducer(state, {
    type: 'SESSION_HISTORY',
    appSessionId: 'active',
    progress: [],
    transcripts: olderPage,
    mode: 'prepend',
    olderCursor: 'older-primary-page',
  });

  assert.ok(next.transcripts.active.length <= 1_200);
  assert.equal(next.transcripts.active.at(-1)?.id, fullTranscript.at(-1)?.id);
  assert.equal(next.historyLoaded.active, false);
  assert.equal(next.sessionRestore.active?.status, 'paged');
});

test('selected child history prepends still enforce the emergency transcript budget', () => {
  const fullChildTranscript = events('active', 33_000).map(
    (event): TranscriptEvent => ({
      ...event,
      sourceSessionId: 'child-a',
      role: 'worker',
    }),
  );
  const existing = fullChildTranscript.slice(2_000);
  const olderPage = fullChildTranscript.slice(0, 2_000);
  const state = stateWithTranscript('active', existing, {
    selectedChild: { parentAppSessionId: 'active', childSessionId: 'child-a' },
    childSessions: {
      active: { 'child-a': childSession('active', 'child-a') },
    },
    childHistory: {
      active: {
        'child-a': {
          status: 'paged',
          loadedCount: existing.length,
          hasMore: true,
          isLoaded: true,
          isLoadingOlder: true,
          olderCursor: 'current-child-page',
          isViewportPinned: false,
        },
      },
    },
  });

  const next = reducer(state, {
    type: 'SESSION_HISTORY',
    appSessionId: 'active',
    childSessionId: 'child-a',
    progress: [],
    transcripts: olderPage,
    mode: 'prepend',
    olderCursor: 'older-child-page',
  });
  const retained = next.transcripts.active.filter((event) => event.sourceSessionId === 'child-a');

  assert.ok(retained.length <= 1_200);
  assert.equal(retained.at(-1)?.id, fullChildTranscript.at(-1)?.id);
  assert.equal(next.childHistory.active['child-a'].status, 'paged');
  assert.equal(next.childHistory.active['child-a'].isLoaded, false);
});

test('child viewport release preserves parent and sibling rows and invalidates only its cursor', () => {
  const primary = events('active', 20);
  const childA = Array.from(
    { length: 4_000 },
    (_, index): TranscriptEvent => ({
      id: `child-a-${index}`,
      appSessionId: 'active',
      sourceSessionId: 'child-a',
      role: 'worker',
      kind: 'text',
      text: `child A event ${index} ${'payload '.repeat(16)}`,
      ts: index + 0.1,
      ...(index % 100 === 0 ? { author: 'user' as const } : {}),
    }),
  );
  const childB = Array.from(
    { length: 30 },
    (_, index): TranscriptEvent => ({
      id: `child-b-${index}`,
      appSessionId: 'active',
      sourceSessionId: 'child-b',
      role: 'validator',
      kind: 'text',
      text: `child B event ${index}`,
      ts: index + 0.2,
    }),
  );
  const transcript = [...primary, ...childA, ...childB];
  const state = stateWithTranscript('active', transcript, {
    selectedChild: { parentAppSessionId: 'active', childSessionId: 'child-a' },
    childSessions: {
      active: {
        'child-a': childSession('active', 'child-a'),
        'child-b': childSession('active', 'child-b', 'validator'),
      },
    },
    childHistory: {
      active: {
        'child-a': {
          status: 'paged',
          loadedCount: childA.length,
          hasMore: true,
          isLoaded: true,
          isLoadingOlder: false,
          olderCursor: 'child-cursor',
          isViewportPinned: true,
        },
      },
    },
  });

  const next = reducer(state, {
    type: 'CHILD_TRANSCRIPT_RELEASE_VIEWPORT',
    parentAppSessionId: 'active',
    childSessionId: 'child-a',
  });

  assert.deepEqual(
    next.transcripts.active
      .filter((event) => event.sourceSessionId === 'primary')
      .map((event) => event.id),
    primary.map((event) => event.id),
  );
  assert.deepEqual(
    next.transcripts.active
      .filter((event) => event.sourceSessionId === 'child-b')
      .map((event) => event.id),
    childB.map((event) => event.id),
  );
  const retainedChild = next.transcripts.active.filter(
    (event) => event.sourceSessionId === 'child-a',
  );
  assert.ok(retainedChild.length < childA.length);
  assert.equal(retainedChild.at(-1)?.id, childA.at(-1)?.id);
  assert.deepEqual(next.childHistory.active['child-a'], {
    status: 'paged',
    loadedCount: retainedChild.length,
    hasMore: true,
    isLoaded: false,
    isLoadingOlder: false,
    isViewportPinned: true,
  });
  assert.equal(Object.hasOwn(next.childHistory.active['child-a'], 'olderCursor'), false);
  assert.equal(transcriptRehydrationLimit(next.childHistory.active['child-a']), 1_200);
  assert.equal(next.historyLoaded.active, true);
});

test('viewport release preserves a scrolled-up or live transcript exactly', () => {
  const transcript = events('active', 4_000);
  const scrolled = stateWithTranscript('active', transcript, {
    transcriptViewportPinned: { active: false },
  });
  const live = stateWithTranscript('active', transcript, {
    sessions: { active: session('active', true) },
  });

  assert.equal(
    reducer(scrolled, {
      type: 'TRANSCRIPT_RELEASE_VIEWPORT',
      appSessionId: 'active',
    }).transcripts.active,
    transcript,
  );
  assert.equal(
    reducer(live, {
      type: 'TRANSCRIPT_RELEASE_VIEWPORT',
      appSessionId: 'active',
    }).transcripts.active,
    transcript,
  );
});

test('switching releases a settled pinned outgoing session but keeps instant tail content', () => {
  const outgoing = events('outgoing', 1_400);
  const state = {
    ...stateWithTranscript('outgoing', outgoing),
    sessions: {
      outgoing: session('outgoing'),
      incoming: session('incoming'),
    },
    sessionOrder: ['incoming', 'outgoing'],
  };

  const next = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'incoming' });

  assert.equal(next.activeAppSessionId, 'incoming');
  assert.ok(next.transcripts.outgoing.length < outgoing.length);
  assert.equal(next.transcripts.outgoing.at(-1)?.id, outgoing.at(-1)?.id);
});

test('switching away releases a settled child tail without releasing parent history', () => {
  const primary = events('active', 2);
  const child = Array.from(
    { length: 1_400 },
    (_, index): TranscriptEvent => ({
      id: `child-${index}`,
      appSessionId: 'active',
      sourceSessionId: 'child-a',
      role: 'worker',
      kind: 'text',
      text: `child event ${index}`,
      ts: index,
      ...(index % 100 === 0 ? { author: 'user' as const } : {}),
    }),
  );
  const state = stateWithTranscript('active', [...primary, ...child], {
    selectedChild: { parentAppSessionId: 'active', childSessionId: 'child-a' },
    childSessions: {
      active: { 'child-a': childSession('active', 'child-a') },
    },
    childHistory: {
      active: {
        'child-a': {
          status: 'loaded',
          loadedCount: child.length,
          hasMore: false,
          isLoaded: true,
          isLoadingOlder: false,
          isViewportPinned: true,
        },
      },
    },
  });

  const next = reducer(state, { type: 'SELECT_CHILD', selection: null });
  const retained = next.transcripts.active.filter((event) => event.sourceSessionId === 'child-a');

  assert.equal(next.selectedChild, null);
  assert.ok(retained.length < child.length);
  assert.equal(retained.at(-1)?.id, child.at(-1)?.id);
  assert.equal(next.childHistory.active['child-a'].isLoaded, false);
  assert.equal(next.historyLoaded.active, true);
});

test('a late child history page is released after the user switches to a sibling', () => {
  const primary = events('active', 2);
  const page = Array.from(
    { length: 1_400 },
    (_, index): TranscriptEvent => ({
      id: `child-a-${index}`,
      appSessionId: 'active',
      sourceSessionId: 'child-a',
      role: 'worker',
      kind: 'text',
      text: `child event ${index}`,
      ts: index,
      ...(index % 100 === 0 ? { author: 'user' as const } : {}),
    }),
  );
  const state = stateWithTranscript('active', primary, {
    selectedChild: { parentAppSessionId: 'active', childSessionId: 'child-b' },
    childSessions: {
      active: {
        'child-a': childSession('active', 'child-a'),
        'child-b': childSession('active', 'child-b'),
      },
    },
    childHistory: {
      active: {
        'child-a': {
          status: 'loading',
          loadedCount: 0,
          hasMore: false,
          isLoaded: false,
          isLoadingOlder: false,
          isViewportPinned: true,
        },
      },
    },
  });

  const next = reducer(state, {
    type: 'SESSION_HISTORY',
    appSessionId: 'active',
    childSessionId: 'child-a',
    progress: [],
    transcripts: page,
    mode: 'replace',
    hasMore: false,
  });
  const retained = next.transcripts.active.filter((event) => event.sourceSessionId === 'child-a');

  assert.deepEqual(next.selectedChild, {
    parentAppSessionId: 'active',
    childSessionId: 'child-b',
  });
  assert.ok(retained.length < page.length);
  assert.equal(retained.at(-1)?.id, page.at(-1)?.id);
  assert.equal(next.childHistory.active['child-a'].isLoaded, false);
  assert.equal(next.historyLoaded.active, true);
});

test('invisible recent-page refresh restores a paging cursor without duplicates', () => {
  const transcript = events('active', 4_000);
  const released = reducer(stateWithTranscript('active', transcript), {
    type: 'TRANSCRIPT_RELEASE_VIEWPORT',
    appSessionId: 'active',
  });
  const recentPage = transcript.slice(-400);

  const refreshed = reducer(released, {
    type: 'SESSION_HISTORY',
    appSessionId: 'active',
    progress: [],
    transcripts: recentPage,
    mode: 'replace',
    olderCursor: 'v2:0:100:0',
  });

  assert.equal(refreshed.historyLoaded.active, true);
  assert.equal(refreshed.historyCursor.active, 'v2:0:100:0');
  assert.equal(
    new Set(refreshed.transcripts.active.map((item) => item.id)).size,
    refreshed.transcripts.active.length,
  );
  assert.equal(refreshed.transcripts.active.at(-1)?.id, transcript.at(-1)?.id);
});

test('emergency ceiling releases a pathological live transcript without trimming event text', () => {
  const transcript = events('active', 30_001);
  const state = stateWithTranscript('active', transcript, {
    sessions: { active: session('active', true) },
  });
  const appended: TranscriptEvent = {
    id: 'active-new',
    appSessionId: 'active',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text: 'complete newest payload',
    ts: 30_002,
  };

  const next = reducer(state, { type: 'SESSION_TRANSCRIPT', event: appended });

  assert.ok(next.transcripts.active.length < transcript.length);
  assert.equal(next.transcripts.active.at(-1)?.id, appended.id);
  assert.equal(next.transcripts.active.at(-1)?.text, appended.text);
});

test('authoritative session removal releases orphaned per-session state', () => {
  const transcript = events('gone', 2);
  const state = stateWithTranscript('gone', transcript, {
    listConfirmedSessionIds: ['gone'],
    transcriptMutations: {
      gone: {
        revision: 1,
        baseRevision: 0,
        kind: 'append',
        previousLength: 0,
        firstChangedIndex: 0,
      },
    },
    progress: { gone: [] },
    childSessions: { gone: {} },
    historyCursor: { gone: 'cursor' },
    utilityPanels: { gone: initialState.utilityPanels.gone },
    browserOpenKeys: { gone: true },
    sessionSettingOverrides: { gone: { modelId: 'model' } },
  });

  const next = reducer(state, { type: 'SESSION_LIST', sessions: [] });

  assert.equal(next.transcripts.gone, undefined);
  assert.equal(next.transcriptMutations.gone, undefined);
  assert.equal(next.transcriptRetainedCost.gone, undefined);
  assert.equal(next.progress.gone, undefined);
  assert.equal(next.childSessions.gone, undefined);
  assert.equal(next.historyCursor.gone, undefined);
  assert.equal(next.browserOpenKeys.gone, undefined);
  assert.equal(next.sessionSettingOverrides.gone, undefined);
});

test('memory pressure releases inactive transcripts and never drops a live turn', () => {
  const settled = events('settled', 2_000);
  const live = events('live', 2_000);
  const state = {
    ...initialState,
    sessions: {
      settled: session('settled', false),
      live: session('live', true),
    },
    sessionOrder: ['settled', 'live'],
    activeAppSessionId: 'live',
    transcripts: { settled, live },
    transcriptRetainedCost: {
      settled: estimateTranscriptCost(settled),
      live: estimateTranscriptCost(live),
    },
    transcriptViewportPinned: { settled: true, live: true },
  };

  const next = reducer(state, { type: 'MEMORY_PRESSURE' });
  assert.ok(next.transcripts.settled.length < settled.length);
  assert.equal(next.transcripts.live.length, live.length);
  assert.equal(next.transcripts.live.at(-1)?.id, live.at(-1)?.id);
});

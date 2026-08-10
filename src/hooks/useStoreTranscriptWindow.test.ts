import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptRehydrationLimit } from '../lib/transcriptStoreMemory';
import { estimateTranscriptCost } from '../lib/transcriptWindow';
import type { SessionSummary, TranscriptEvent } from '../types/bridge';
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
  assert.equal(
    transcriptRehydrationLimit(next.sessionRestore.active),
    next.transcripts.active.length,
  );
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
    progress: { gone: [] },
    childSessions: { gone: {} },
    historyCursor: { gone: 'cursor' },
    utilityPanels: { gone: initialState.utilityPanels.gone },
    browserOpenKeys: { gone: true },
    sessionSettingOverrides: { gone: { modelId: 'model' } },
  });

  const next = reducer(state, { type: 'SESSION_LIST', sessions: [] });

  assert.equal(next.transcripts.gone, undefined);
  assert.equal(next.transcriptRetainedCost.gone, undefined);
  assert.equal(next.progress.gone, undefined);
  assert.equal(next.childSessions.gone, undefined);
  assert.equal(next.historyCursor.gone, undefined);
  assert.equal(next.browserOpenKeys.gone, undefined);
  assert.equal(next.sessionSettingOverrides.gone, undefined);
});

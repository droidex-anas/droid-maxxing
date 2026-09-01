import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetRendererPerfForTest,
  getRendererPerfSnapshot,
  noteBridgeEventReceived,
  noteStoreCommitted,
  discardPendingBridgeEvent,
  noteFeedProjection,
  setMountedFeedRows,
  noteRendererHtmlLoaded,
  noteFirstMeaningfulShellPaint,
  noteComposerInteractive,
  noteComposerNotApplicable,
} from './rendererPerf';
import type { ServerEvent } from '../types/bridge';

interface FakeFrame {
  callback: () => void;
}

function withFakeRaf(fn: () => void): FakeFrame[] {
  const frames: FakeFrame[] = [];
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (callback) => {
    frames.push({ callback });
    return frames.length;
  };
  try {
    fn();
  } finally {
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  }
  return frames;
}

function appendedEvent(ts: number): Extract<ServerEvent, { type: 'event.appended' }> {
  return {
    type: 'event.appended',
    event: {
      id: `event-${String(ts)}`,
      appSessionId: 'app-1',
      sourceSessionId: 'app-1',
      role: 'primary',
      ts,
      kind: 'text',
      text: 'hello',
    },
  };
}

test('startup phases are recorded once in order for composer sessions', () => {
  resetRendererPerfForTest();
  noteRendererHtmlLoaded();
  noteFirstMeaningfulShellPaint();
  noteComposerInteractive();
  noteBridgeEventReceived({ type: 'connection', status: 'connected' });
  noteBridgeEventReceived({ type: 'sessions.list', sessions: [] });

  noteRendererHtmlLoaded();
  noteFirstMeaningfulShellPaint();
  noteComposerInteractive();
  noteBridgeEventReceived({ type: 'connection', status: 'connected' });
  noteBridgeEventReceived({ type: 'sessions.list', sessions: [] });

  const phases = getRendererPerfSnapshot().startupPhases;
  assert.ok(phases.rendererHtmlLoadedMs !== undefined);
  assert.ok(phases.firstMeaningfulShellPaintMs !== undefined);
  assert.equal(phases.composerInteractive.status, 'marked');
  if (phases.composerInteractive.status !== 'marked') throw new Error('unreachable');
  assert.ok(phases.composerInteractive.atMs !== undefined);
  assert.ok(phases.sidecarConnectedMs !== undefined);
  assert.ok(phases.sessionListReadyMs !== undefined);
  assert.ok(phases.rendererHtmlLoadedMs <= phases.firstMeaningfulShellPaintMs!);
  assert.ok(phases.firstMeaningfulShellPaintMs! <= phases.composerInteractive.atMs);
  assert.ok(phases.composerInteractive.atMs <= phases.sidecarConnectedMs!);
  assert.ok(phases.sidecarConnectedMs! <= phases.sessionListReadyMs!);
});

test('composer-less startup records notApplicable instead of a fabricated mark', () => {
  resetRendererPerfForTest();
  noteRendererHtmlLoaded();
  noteFirstMeaningfulShellPaint();
  noteComposerNotApplicable();
  noteComposerInteractive();

  const phases = getRendererPerfSnapshot().startupPhases;
  assert.equal(phases.composerInteractive.status, 'notApplicable');
  assert.equal(phases.composerInteractive.status === 'marked', false);
});

test('receive → commit → paint legs are measured per batch', () => {
  resetRendererPerfForTest();
  let frames: FakeFrame[] = [];
  frames = withFakeRaf(() => {
    noteBridgeEventReceived({ type: 'sessions.list', sessions: [] });
    noteBridgeEventReceived(appendedEvent(performance.timeOrigin + performance.now() - 5));
    noteStoreCommitted();
    // Events arriving after the commit belong to the next batch.
    noteBridgeEventReceived(appendedEvent(performance.timeOrigin + performance.now()));
  });

  let snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.eventsReceived, 3);
  assert.equal(snapshot.appendedReceived, 2);
  assert.equal(snapshot.receiveToCommitMs.count, 2);
  assert.equal(snapshot.receiveToPaintMs.count, 0, 'paint waits for the animation frame');
  assert.equal(frames.length, 1, 'one rAF is scheduled per committed batch');

  frames[0]?.callback();
  snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.receiveToPaintMs.count, 2);
  assert.ok(snapshot.receiveToPaintMs.p50Ms !== undefined);
  assert.ok(snapshot.appendToReceiveMs.count === 2);

  // The post-commit event reduces on the next commit; commits with nothing
  // pending record nothing.
  noteStoreCommitted();
  assert.equal(getRendererPerfSnapshot().receiveToCommitMs.count, 3);
  noteStoreCommitted();
  assert.equal(getRendererPerfSnapshot().receiveToCommitMs.count, 3, 'idle commits record nothing');
});

test('append-to-receive measures the bridge event age at socket read', () => {
  resetRendererPerfForTest();
  const ageMs = 40;
  noteBridgeEventReceived(appendedEvent(performance.timeOrigin + performance.now() - ageMs));
  const snapshot = getRendererPerfSnapshot();
  assert.ok(snapshot.appendToReceiveMs.p50Ms !== undefined);
  assert.ok(
    snapshot.appendToReceiveMs.p50Ms >= ageMs - 2,
    `expected ~${String(ageMs)}ms, got ${String(snapshot.appendToReceiveMs.p50Ms)}`,
  );
});

test('without requestAnimationFrame the paint leg stays unmeasured', () => {
  resetRendererPerfForTest();
  assert.equal(
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame,
    undefined,
    'node test env has no rAF',
  );

  noteBridgeEventReceived({ type: 'history.list', sessions: [] });
  noteStoreCommitted();

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.receiveToCommitMs.count, 1);
  assert.equal(snapshot.receiveToPaintMs.count, 0);
});

test('mounted feed rows track current and peak values', () => {
  resetRendererPerfForTest();
  setMountedFeedRows(120);
  setMountedFeedRows(80);

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.mountedFeedRows, 80);
  assert.equal(snapshot.mountedFeedRowsMax, 120);
});

test('feed projection metrics distinguish rebuilds, reuse, and invisible appends', () => {
  resetRendererPerfForTest();
  noteFeedProjection({
    mode: 'full',
    durationMs: 5,
    visibleEventCount: 100,
    reusedVisibleEventCount: 0,
  });
  noteFeedProjection({
    mode: 'incremental',
    durationMs: 1,
    visibleEventCount: 101,
    reusedVisibleEventCount: 100,
  });
  noteFeedProjection({
    mode: 'cache',
    durationMs: 0.1,
    visibleEventCount: 101,
    reusedVisibleEventCount: 101,
  });
  noteFeedProjection({
    mode: 'invisible',
    durationMs: 0.2,
    visibleEventCount: 101,
    reusedVisibleEventCount: 101,
  });

  const snapshot = getRendererPerfSnapshot().feedProjection;
  assert.equal(snapshot.fullBuilds, 1);
  assert.equal(snapshot.incrementalBuilds, 1);
  assert.equal(snapshot.cacheHits, 1);
  assert.equal(snapshot.invisibleAppendHits, 1);
  assert.equal(snapshot.eventsRebuilt, 101);
  assert.equal(snapshot.eventsReused, 302);
  assert.equal(snapshot.durationMs.count, 4);
  assert.equal(snapshot.durationMs.maxMs, 5);
});

test('discarded events never contribute a commit or paint sample', () => {
  resetRendererPerfForTest();
  withFakeRaf(() => {
    const discarded = appendedEvent(performance.timeOrigin + performance.now() - 5);
    noteBridgeEventReceived({ type: 'sessions.list', sessions: [] });
    noteBridgeEventReceived(discarded);
    // adaptEvent returned null for the second event: its pending leg must go.
    discardPendingBridgeEvent(discarded);
    noteStoreCommitted();
  });

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.eventsReceived, 2);
  assert.equal(
    snapshot.receiveToCommitMs.count,
    1,
    'only the surviving event records a commit sample',
  );
});

function withFakedPerfClock(offsetMs: number, fn: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const realNow = performance.now.bind(performance);
  const fake = Object.create(performance, {
    now: { value: () => realNow() + offsetMs },
  }) as Performance;
  Object.defineProperty(globalThis, 'performance', { value: fake, configurable: true });
  try {
    fn();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'performance', descriptor);
  }
}

test('a stale awaiting-paint batch is dropped, not stamped late', () => {
  resetRendererPerfForTest();
  const frames = withFakeRaf(() => {
    noteBridgeEventReceived(appendedEvent(performance.timeOrigin + performance.now()));
    noteStoreCommitted();
  });
  // Advance the clock past the staleness threshold, commit a fresh batch,
  // then run the still-pending frame: the aged entry must be gone while the
  // fresh one is stamped.
  withFakedPerfClock(60_000, () => {
    withFakeRaf(() => {
      noteBridgeEventReceived({ type: 'sessions.list', sessions: [] });
      noteStoreCommitted();
    });
    frames[0]?.callback();
  });

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.receiveToCommitMs.count, 2);
  assert.equal(snapshot.receiveToPaintMs.count, 1, 'only the fresh entry records a paint sample');
});

test('a paint frame that runs late records nothing stale', () => {
  resetRendererPerfForTest();
  const frames = withFakeRaf(() => {
    noteBridgeEventReceived(appendedEvent(performance.timeOrigin + performance.now()));
    noteStoreCommitted();
  });
  withFakedPerfClock(60_000, () => {
    frames[0]?.callback();
  });

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.receiveToCommitMs.count, 1);
  assert.equal(
    snapshot.receiveToPaintMs.count,
    0,
    'a frame firing past the threshold stamps nothing',
  );
});

test('the pre-commit telemetry queue drops oldest samples once it hits capacity', () => {
  resetRendererPerfForTest();
  const overflow = 10;
  const capacity = 4_096;
  for (let index = 0; index < capacity + overflow; index += 1) {
    noteBridgeEventReceived({ type: 'history.persistenceRecovered' });
  }
  noteStoreCommitted();

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.eventsReceived, capacity + overflow);
  assert.equal(snapshot.receiveToCommitMs.count, capacity);
});

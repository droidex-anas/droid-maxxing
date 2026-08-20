import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetRendererPerfForTest,
  getRendererPerfSnapshot,
  noteBridgeEventReceived,
  noteStoreCommitted,
  discardPendingBridgeEvent,
  setMountedTranscriptRows,
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

test('mounted transcript rows track current and peak values', () => {
  resetRendererPerfForTest();
  setMountedTranscriptRows(120);
  setMountedTranscriptRows(80);

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.mountedTranscriptRows, 80);
  assert.equal(snapshot.mountedTranscriptRowsMax, 120);
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

test('a stale awaiting-paint batch is dropped, not stamped late', () => {
  resetRendererPerfForTest();
  // Committed batches whose rAF callbacks never run (a backgrounded tab).
  // Their pending entries stay in awaitingPaint across frames.
  withFakeRaf(() => {
    noteBridgeEventReceived(appendedEvent(performance.timeOrigin + performance.now()));
    noteStoreCommitted();
  });
  const originalNow = performance.now.bind(performance);
  try {
    // Advance the perf clock past the staleness threshold, then commit a
    // fresh batch: scheduling must clear the aged entries instead of
    // recording paint samples against a frame that never ran.
    (globalThis as { performance: Performance }).performance = Object.create(performance, {
      now: { value: () => originalNow() + 60_000 },
    }) as Performance;
    withFakeRaf(() => {
      noteBridgeEventReceived({ type: 'sessions.list', sessions: [] });
      noteStoreCommitted();
    });
  } finally {
    (globalThis as { performance: Performance }).performance = originalNow as Performance;
  }

  const snapshot = getRendererPerfSnapshot();
  assert.equal(snapshot.receiveToCommitMs.count, 2);
  assert.equal(
    snapshot.receiveToPaintMs.count,
    0,
    'stale paint legs are dropped instead of recorded',
  );
});

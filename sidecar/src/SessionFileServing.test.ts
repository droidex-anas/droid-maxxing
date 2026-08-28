import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionSummary } from './protocol.js';
import { SessionFileServing } from './SessionFileServing.js';

test('start begins boot reconcile without emitting a list', async () => {
  let reconcileCalls = 0;
  let emitted = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const serving = new SessionFileServing({
    history: {
      async reconcileSessionFiles() {
        reconcileCalls += 1;
        await gate;
        return 1;
      },
      async reconcileSessionFilePaths() {
        return 0;
      },
    },
    startWatcher: () => null,
    isLiveSession: () => false,
    isShutdownStarted: () => false,
    retryPendingLaunchSettings: () => undefined,
    listSummaries: () => ({ sessions: [] as SessionSummary[], earlierSessionsByCwd: {} }),
    emitList: () => {
      emitted += 1;
    },
  });

  serving.start();
  const listed = serving.list({});
  await Promise.resolve();
  assert.equal(reconcileCalls, 1);
  assert.equal(emitted, 0, 'the first list waits for the in-flight boot reconcile');
  release?.();
  await listed;
  assert.equal(emitted, 1);
  assert.equal(reconcileCalls, 1, 'start and list share one boot reconcile');
});

test('whenBootReconciled waits for the in-flight boot reconcile without listing', async () => {
  let reconcileCalls = 0;
  let emitted = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const serving = new SessionFileServing({
    history: {
      async reconcileSessionFiles() {
        reconcileCalls += 1;
        await gate;
        return 1;
      },
      async reconcileSessionFilePaths() {
        return 0;
      },
    },
    startWatcher: () => null,
    isLiveSession: () => false,
    isShutdownStarted: () => false,
    retryPendingLaunchSettings: () => undefined,
    listSummaries: () => ({ sessions: [] as SessionSummary[], earlierSessionsByCwd: {} }),
    emitList: () => {
      emitted += 1;
    },
  });

  serving.start();
  const ready = serving.whenBootReconciled();
  await Promise.resolve();
  assert.equal(reconcileCalls, 1);
  let settled = false;
  void ready.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(emitted, 0);
  release?.();
  await ready;
  assert.equal(settled, true);
  assert.equal(emitted, 0);
  assert.equal(reconcileCalls, 1, 'start and restore share one boot reconcile');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  childRuntimeAdmission,
  childRuntimeLimits,
  decideChildRuntimeCapacity,
  enqueueChildRuntime,
  takeNextQueuedChild,
} from './childRuntimeBudget.js';
import {
  childStateFromRecord,
  type ChildSessionState,
  type ParentChildSessions,
} from './ChildSessionState.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';

const budget = { maxLive: 2, maxQueued: 3 };

test('admits while live runtimes are under the configured limit', () => {
  assert.equal(
    childRuntimeAdmission(budget, { live: 1, reserved: 0, queued: 0, idleLive: 0 }),
    'admit',
  );
});

test('admits by evicting an idle live runtime before queueing', () => {
  assert.equal(
    childRuntimeAdmission(budget, { live: 2, reserved: 0, queued: 0, idleLive: 1 }),
    'admit',
  );
});

test('queues busy overflow under the live limit and rejects a full queue', () => {
  assert.equal(
    childRuntimeAdmission(budget, { live: 2, reserved: 0, queued: 0, idleLive: 0 }),
    'queue',
  );
  assert.equal(
    childRuntimeAdmission(budget, { live: 2, reserved: 0, queued: 2, idleLive: 0 }),
    'queue',
  );
  assert.equal(
    childRuntimeAdmission(budget, { live: 2, reserved: 0, queued: 3, idleLive: 0 }),
    'reject',
  );
});

test('hard-max occupancy of four live runtimes still admits the fourth and queues the fifth', () => {
  const hardMax = { maxLive: 4, maxQueued: 16 };
  assert.equal(
    childRuntimeAdmission(hardMax, { live: 3, reserved: 0, queued: 0, idleLive: 0 }),
    'admit',
  );
  assert.equal(
    childRuntimeAdmission(hardMax, { live: 4, reserved: 0, queued: 0, idleLive: 0 }),
    'queue',
  );
});

function child(id: string, lastUsedAt = 0): ChildSessionState {
  const state = childStateFromRecord({
    parentAppSessionId: 'parent',
    childSessionId: id,
    providerSessionId: `provider-${id}`,
    role: 'worker',
    status: 'paused',
    modelId: 'model-default',
    transcriptAvailable: true,
    updatedAt: 1,
  });
  state.runtime = {
    session: new FakeFactorySession(`provider-${id}`, {}, []),
    generation: 1,
    lastUsedAt,
  };
  return state;
}

function parentOf(...children: ChildSessionState[]): ParentChildSessions {
  return {
    parentAppSessionId: 'parent',
    generation: 1,
    lease: {
      summary: {} as ParentChildSessions['lease']['summary'],
      session: new FakeFactorySession('parent-provider', {}, []),
      mcpConfigs: [],
    },
    children: new Map(children.map((entry) => [entry.identity.childSessionId, entry])),
    pendingSpawns: new Map(),
    openAttempts: new Map(),
    reservedOpenSlots: new Set(),
    runtimeQueue: [],
    closing: false,
  };
}

test('capacity reserves while live plus reserved are under the limit', () => {
  const requested = child('requested');
  requested.runtime = undefined;
  const parent = parentOf(child('live', 1), requested);
  assert.deepEqual(decideChildRuntimeCapacity(parent, requested, budget), { action: 'reserve' });
});

test('capacity evicts the least-recently-used idle runtime at the live limit', () => {
  const older = child('older', 1);
  const newer = child('newer', 9);
  const requested = child('requested');
  requested.runtime = undefined;
  const parent = parentOf(older, newer, requested);
  assert.deepEqual(decideChildRuntimeCapacity(parent, requested, budget), {
    action: 'evict',
    victim: older,
  });
});

test('capacity queues when every live runtime is busy and the queue has room', () => {
  const busy = child('busy', 1);
  busy.turn.phase = 'streaming';
  const other = child('other', 2);
  other.turn.phase = 'streaming';
  const requested = child('requested');
  requested.runtime = undefined;
  const parent = parentOf(busy, other, requested);
  assert.deepEqual(decideChildRuntimeCapacity(parent, requested, budget), { action: 'queue' });
});

test('capacity rejects when the queue is already full', () => {
  const busy = child('busy', 1);
  busy.turn.phase = 'streaming';
  const other = child('other', 2);
  other.turn.phase = 'streaming';
  const requested = child('requested');
  requested.runtime = undefined;
  const parent = parentOf(busy, other, requested);
  parent.runtimeQueue = ['a', 'b', 'c'];
  assert.deepEqual(decideChildRuntimeCapacity(parent, requested, budget), { action: 'reject' });
});

test('enqueue is idempotent on queue membership and records the request', () => {
  const requested = child('requested');
  requested.runtime = undefined;
  const parent = parentOf(requested);
  enqueueChildRuntime(parent, requested, 'open-1');
  enqueueChildRuntime(parent, requested, 'open-2');
  assert.deepEqual(parent.runtimeQueue, ['requested']);
  assert.equal(requested.queued, true);
  assert.equal(requested.queuedRequestId, 'open-2');
});

test('takeNextQueuedChild skips already-live children and stops at the live cap', () => {
  const queued = child('queued');
  queued.runtime = undefined;
  queued.queued = true;
  queued.queuedRequestId = 'open-1';
  const skipped = child('skipped', 1);
  skipped.queued = true;
  const parent = parentOf(skipped, queued);
  parent.runtimeQueue = ['skipped', 'queued'];
  parent.reservedOpenSlots.add('reserved');

  assert.equal(takeNextQueuedChild(parent, 1), undefined);
  assert.deepEqual(parent.runtimeQueue, ['skipped', 'queued']);

  const next = takeNextQueuedChild(
    parent,
    childRuntimeLimits({
      maxLiveRuntimes: 4,
      maxOpenSessions: 4,
      maxQueuedRuntimes: 3,
    }).maxLive,
  );
  assert.equal(next?.child.identity.childSessionId, 'queued');
  assert.equal(next?.requestId, 'open-1');
  assert.equal(queued.queued, false);
  assert.equal(queued.queuedRequestId, undefined);
  assert.deepEqual(parent.runtimeQueue, []);
});

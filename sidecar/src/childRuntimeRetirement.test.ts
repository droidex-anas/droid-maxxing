import assert from 'node:assert/strict';
import test from 'node:test';

import {
  childStateFromRecord,
  type ChildSessionState,
  type ParentChildSessions,
} from './ChildSessionState.js';
import type { PersistedChildSession } from './ChildSessionState.js';
import {
  nextChildRuntimeRetirementAt,
  parentHasUnsettledChildren,
  retirableChildRuntimes,
} from './childRuntimeRetirement.js';
import { RuntimeRetirementTimer } from './runtimeRetirementTimer.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { droidParentLease, stubChildRuntime } from './testing/droidProviderTestSupport.js';

const IDLE_MS = 300_000;
const nothingUndelivered = () => false;

function record(childSessionId: string): PersistedChildSession {
  return {
    parentAppSessionId: 'parent',
    childSessionId,
    providerSessionId: `provider-${childSessionId}`,
    role: 'worker',
    status: 'paused',
    modelId: 'model-default',
    transcriptAvailable: true,
    updatedAt: 1,
  };
}

function liveChild(
  childSessionId: string,
  lastUsedAt: number,
  patch: Partial<ChildSessionState> = {},
): ChildSessionState {
  const child = childStateFromRecord(record(childSessionId));
  child.runtime = stubChildRuntime(
    new FakeFactorySession(`provider-${childSessionId}`, {}, []),
    1,
    lastUsedAt,
  );
  return Object.assign(child, patch);
}

function parentOf(...children: ChildSessionState[]): ParentChildSessions {
  return {
    parentAppSessionId: 'parent',
    generation: 1,
    lease: droidParentLease(
      {} as ParentChildSessions['lease']['summary'],
      new FakeFactorySession('parent-provider', {}, []),
    ),
    children: new Map(children.map((child) => [child.identity.childSessionId, child])),
    pendingSpawns: new Map(),
    openAttempts: new Map(),
    reservedOpenSlots: new Set(),
    runtimeQueue: [],
    closing: false,
  };
}

const retirableIds = (parent: ParentChildSessions, now: number): string[] =>
  retirableChildRuntimes([parent], now, IDLE_MS, nothingUndelivered).map(
    ({ child }) => child.identity.childSessionId,
  );

test('a settled child is retirable only once it passes the idle budget', () => {
  const parent = parentOf(liveChild('settled', 1_000));

  assert.deepEqual(retirableIds(parent, 1_000 + IDLE_MS - 1), []);
  assert.deepEqual(retirableIds(parent, 1_000 + IDLE_MS), ['settled']);
});

test('a child with work in flight is never retirable, however long it sits', () => {
  const forever = 1_000 + IDLE_MS * 100;
  const busy: [string, Partial<ChildSessionState>][] = [
    ['streaming', { turn: { ...childStateFromRecord(record('x')).turn, phase: 'streaming' } }],
    ['compacting', { turn: { ...childStateFromRecord(record('x')).turn, autoCompacting: true } }],
    [
      'pending-send',
      { turn: { ...childStateFromRecord(record('x')).turn, pendingSends: ['queued'] } },
    ],
    ['interrupting', { turn: { ...childStateFromRecord(record('x')).turn, interrupting: true } }],
    [
      'steering',
      { turn: { ...childStateFromRecord(record('x')).turn, interruptingForSteer: true } },
    ],
    ['parent-reports-running', { status: 'running' }],
    ['closing-itself', { closeWhenIdle: true }],
    ['queued-for-capacity', { queued: true }],
    ['mid-mutation', { mutationTail: Promise.resolve() }],
  ];

  for (const [label, patch] of busy) {
    const parent = parentOf(liveChild(label, 1_000, patch));
    assert.deepEqual(retirableIds(parent, forever), [], `${label} must never be retired`);
  }
});

test('a child whose result is not yet persisted is never retirable', () => {
  const parent = parentOf(liveChild('undelivered', 1_000));
  const awaitingDurability = (child: ChildSessionState) =>
    child.identity.childSessionId === 'undelivered';

  assert.deepEqual(
    retirableChildRuntimes([parent], 1_000 + IDLE_MS, IDLE_MS, awaitingDurability),
    [],
  );
});

test('a child without a runtime, mid-open, or under a closing parent is skipped', () => {
  const noRuntime = childStateFromRecord(record('cold'));
  const opening = liveChild('opening', 1_000);
  const parent = parentOf(noRuntime, opening);
  parent.openAttempts.set('opening', {
    settled: Promise.resolve(),
    settle: () => undefined,
    cancelled: Promise.resolve(),
    cancel: () => undefined,
    isCancelled: false,
  });
  assert.deepEqual(retirableIds(parent, 1_000 + IDLE_MS), []);

  const closing = parentOf(liveChild('settled', 1_000));
  closing.closing = true;
  assert.deepEqual(retirableIds(closing, 1_000 + IDLE_MS), []);
});

test('the next deadline follows the child that went idle first', () => {
  const parent = parentOf(liveChild('older', 1_000), liveChild('newer', 4_000));

  assert.equal(
    nextChildRuntimeRetirementAt([parent], IDLE_MS, nothingUndelivered),
    1_000 + IDLE_MS,
  );
  assert.equal(nextChildRuntimeRetirementAt([parentOf()], IDLE_MS, nothingUndelivered), undefined);
});

test('the timer arms for the earliest deadline and disarms when nothing is idle', () => {
  const scheduled: number[] = [];
  const cleared: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let handle = 0;
  Reflect.set(globalThis, 'setTimeout', (_fn: () => void, ms: number) => {
    scheduled.push(ms);
    handle += 1;
    return { unref: () => undefined, id: handle };
  });
  Reflect.set(globalThis, 'clearTimeout', (timer: { id: number }) => {
    cleared.push(timer.id);
  });
  try {
    const timer = new RuntimeRetirementTimer(() => undefined);

    timer.armFor(5_000, 1_000);
    assert.deepEqual(scheduled, [4_000]);
    assert.equal(timer.armedFor(), 5_000);

    // A later deadline must not push back a wakeup that is already pending.
    timer.armFor(9_000, 1_000);
    assert.deepEqual(scheduled, [4_000]);

    timer.armFor(2_000, 1_000);
    assert.deepEqual(scheduled, [4_000, 1_000]);
    assert.equal(timer.armedFor(), 2_000);

    timer.armFor(undefined, 1_000);
    assert.equal(timer.armedFor(), undefined);
    assert.equal(cleared.length, 2);
  } finally {
    Reflect.set(globalThis, 'setTimeout', realSetTimeout);
    Reflect.set(globalThis, 'clearTimeout', realClearTimeout);
  }
});

test('a parent is unsettled while anything in its child subtree is still in flight', () => {
  const settled = liveChild('settled', 1_000);
  assert.equal(
    parentHasUnsettledChildren(undefined, () => false),
    false,
  );
  assert.equal(
    parentHasUnsettledChildren(parentOf(settled), () => false),
    false,
  );

  const pending = parentOf(settled);
  pending.pendingSpawns.set('spawn', {
    parentAppSessionId: 'parent',
    role: 'worker',
  });
  assert.equal(
    parentHasUnsettledChildren(pending, () => false),
    true,
  );

  const opening = parentOf(settled);
  opening.openAttempts.set('settled', {
    settled: Promise.resolve(),
    settle: () => undefined,
    cancelled: Promise.resolve(),
    cancel: () => undefined,
    isCancelled: false,
  });
  assert.equal(
    parentHasUnsettledChildren(opening, () => false),
    true,
  );

  const reserved = parentOf(settled);
  reserved.reservedOpenSlots.add('other');
  assert.equal(
    parentHasUnsettledChildren(reserved, () => false),
    true,
  );

  const queued = parentOf(settled);
  queued.runtimeQueue = ['other'];
  assert.equal(
    parentHasUnsettledChildren(queued, () => false),
    true,
  );

  const working = parentOf(liveChild('working', 1_000, { status: 'running' }));
  assert.equal(
    parentHasUnsettledChildren(working, () => false),
    true,
  );

  assert.equal(
    parentHasUnsettledChildren(
      parentOf(settled),
      (child) => child.identity.childSessionId === 'settled',
    ),
    true,
  );
});

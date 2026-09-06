import assert from 'node:assert/strict';
import test from 'node:test';

import { childRuntimeAdmission } from './childRuntimeBudget.js';
import {
  CONTEXT_POLL_ACTIVE_MS,
  ContextPollHost,
  contextPollIntervalMs,
} from './contextPollScheduler.js';

test('a multi-hour-equivalent workload plateaus pollers and child runtimes', () => {
  const polls: string[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextId = 1;
  let tier: 'interactive' | 'hidden' | 'low-power' = 'interactive';
  const host = new ContextPollHost<{ session: object; appSessionId: string }>({
    setIntervalFn: ((callback: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: ((id: ReturnType<typeof setInterval>) => {
      timers.delete(id as unknown as number);
    }) as typeof clearInterval,
    cadenceFor: (target) =>
      contextPollIntervalMs({
        tier,
        isChild: target.appSessionId.startsWith('child'),
        focusedAppSessionId: 'app-1',
        appSessionId: target.appSessionId,
      }),
    poll: (target) => {
      polls.push(target.appSessionId);
    },
  });

  host.start('primary:app-1', { session: {}, appSessionId: 'app-1' });
  host.start('child:app-1', { session: {}, appSessionId: 'child-1' });
  host.start('primary:app-2', { session: {}, appSessionId: 'app-2' });
  assert.equal(host.counts().active, 3);
  assert.equal(timers.size, 3);

  const ticksBeforeHide = polls.length;
  for (const timer of timers.values()) timer.callback();
  assert.equal(polls.length, ticksBeforeHide + 3);

  tier = 'hidden';
  host.reschedule();
  assert.equal(host.counts().active, 0);
  assert.equal(timers.size, 0);
  const hiddenPolls = polls.length;

  tier = 'interactive';
  host.reschedule();
  assert.equal(host.counts().active, 3);
  assert.ok(polls.length > hiddenPolls);

  let occupancy = { live: 2, reserved: 0, queued: 0, idleLive: 0 };
  assert.equal(childRuntimeAdmission({ maxLive: 2, maxQueued: 8 }, occupancy), 'queue');
  occupancy = { live: 2, reserved: 0, queued: 1, idleLive: 0 };
  assert.equal(childRuntimeAdmission({ maxLive: 2, maxQueued: 8 }, occupancy), 'queue');
  occupancy = { live: 2, reserved: 0, queued: 8, idleLive: 0 };
  assert.equal(childRuntimeAdmission({ maxLive: 2, maxQueued: 8 }, occupancy), 'reject');

  assert.equal(CONTEXT_POLL_ACTIVE_MS, 2_500);
  host.clearAll();
  assert.equal(host.counts().total, 0);
});

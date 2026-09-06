import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_POLL_ACTIVE_MS,
  CONTEXT_POLL_BACKGROUND_MS,
  CONTEXT_POLL_INACTIVE_MS,
  ContextPollHost,
  contextPollIntervalMs,
} from './contextPollScheduler.js';

test('visible focused primary keeps the current cadence', () => {
  assert.equal(
    contextPollIntervalMs({
      tier: 'interactive',
      isChild: false,
      focusedAppSessionId: 'app-1',
      appSessionId: 'app-1',
    }),
    CONTEXT_POLL_ACTIVE_MS,
  );
});

test('active background children poll slower than the focused primary', () => {
  assert.equal(
    contextPollIntervalMs({
      tier: 'interactive',
      isChild: true,
      focusedAppSessionId: 'app-1',
      appSessionId: 'app-1',
    }),
    CONTEXT_POLL_BACKGROUND_MS,
  );
});

test('unfocused primary sessions poll much slower', () => {
  assert.equal(
    contextPollIntervalMs({
      tier: 'interactive',
      isChild: false,
      focusedAppSessionId: 'app-1',
      appSessionId: 'app-2',
    }),
    CONTEXT_POLL_INACTIVE_MS,
  );
});

test('children of an unfocused session use the inactive cadence', () => {
  assert.equal(
    contextPollIntervalMs({
      tier: 'interactive',
      isChild: true,
      focusedAppSessionId: 'app-1',
      appSessionId: 'app-2',
    }),
    CONTEXT_POLL_INACTIVE_MS,
  );
});

test('hidden and low-power tiers pause informational polling', () => {
  assert.equal(
    contextPollIntervalMs({
      tier: 'hidden',
      isChild: false,
      focusedAppSessionId: 'app-1',
      appSessionId: 'app-1',
    }),
    0,
  );
  assert.equal(
    contextPollIntervalMs({
      tier: 'low-power',
      isChild: true,
      focusedAppSessionId: 'app-1',
      appSessionId: 'app-1',
    }),
    0,
  );
});

test('poll host pauses timers when cadence drops to zero and resumes with an immediate poll', () => {
  const polls: string[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextId = 1;
  let cadence = 2_500;
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
    cadenceFor: () => cadence,
    poll: (target) => {
      polls.push(target.appSessionId);
    },
  });

  const target = { session: {}, appSessionId: 'app-1' };
  host.start('primary:app-1', target);
  assert.deepEqual(polls, ['app-1']);
  assert.equal(host.counts().active, 1);
  assert.equal([...timers.values()][0]?.ms, 2_500);

  cadence = 0;
  host.reschedule();
  assert.equal(host.counts().active, 0);
  assert.equal(timers.size, 0);

  cadence = 10_000;
  host.reschedule();
  assert.deepEqual(polls, ['app-1', 'app-1']);
  assert.equal(host.counts().active, 1);
  assert.equal([...timers.values()][0]?.ms, 10_000);

  host.clearAll();
  assert.equal(host.counts().total, 0);
  assert.equal(timers.size, 0);
});

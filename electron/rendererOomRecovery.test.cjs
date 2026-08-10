const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererOomRecovery } = require('./rendererOomRecovery.cjs');

function harness(options = {}) {
  let now = 0;
  let nextTimer = 0;
  const scheduled = new Map();
  const recovery = createRendererOomRecovery({
    now: () => now,
    schedule: (callback, delayMs) => {
      const id = ++nextTimer;
      scheduled.set(id, { callback, delayMs });
      return id;
    },
    cancelScheduled: (id) => scheduled.delete(id),
    recoveryDelayMs: 25,
    recoveryWindowMs: 1_000,
    maxRecoveries: 2,
    ...options,
  });
  return {
    recovery,
    scheduled,
    setNow(value) {
      now = value;
    },
    run(id) {
      const timer = scheduled.get(id);
      if (!timer) return;
      scheduled.delete(id);
      timer.callback();
    },
  };
}

test('only renderer OOM exits schedule an automatic reload', () => {
  const h = harness();
  let reloads = 0;

  assert.equal(
    h.recovery.handle({ reason: 'crashed' }, () => reloads++),
    false,
  );
  assert.equal(h.scheduled.size, 0);
  assert.equal(
    h.recovery.handle({ reason: 'oom' }, () => reloads++),
    true,
  );
  assert.equal(h.scheduled.size, 1);
  const [timerId, timer] = h.scheduled.entries().next().value;
  assert.equal(timer.delayMs, 25);
  h.run(timerId);
  assert.equal(reloads, 1);
});

test('repeated OOM exits are rate-limited to avoid a reload crash loop', () => {
  const h = harness();
  let reloads = 0;

  assert.equal(
    h.recovery.handle({ reason: 'oom' }, () => reloads++),
    true,
  );
  h.run(1);
  h.setNow(100);
  assert.equal(
    h.recovery.handle({ reason: 'oom' }, () => reloads++),
    true,
  );
  h.run(2);
  h.setNow(200);
  assert.equal(
    h.recovery.handle({ reason: 'oom' }, () => reloads++),
    false,
  );
  assert.equal(reloads, 2);

  h.setNow(1_200);
  assert.equal(
    h.recovery.handle({ reason: 'oom' }, () => reloads++),
    true,
  );
});

test('cancel clears a pending repair when the owning window closes', () => {
  const h = harness();
  let reloads = 0;
  h.recovery.handle({ reason: 'oom' }, () => reloads++);

  h.recovery.cancel();
  h.run(1);

  assert.equal(h.scheduled.size, 0);
  assert.equal(reloads, 0);
});

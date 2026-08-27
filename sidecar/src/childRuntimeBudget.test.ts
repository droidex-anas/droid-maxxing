import assert from 'node:assert/strict';
import test from 'node:test';

import { childRuntimeAdmission } from './childRuntimeBudget.js';

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

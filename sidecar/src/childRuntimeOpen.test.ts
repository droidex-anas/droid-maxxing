import assert from 'node:assert/strict';
import test from 'node:test';

import {
  childStateFromRecord,
  type ChildOpenAttempt,
  type ParentChildSessions,
} from './ChildSessionState.js';
import {
  CHILD_OPEN_CANCELLED,
  awaitOpenStep,
  beginOpenAttempt,
  cancelOpenAttempts,
  finishOpenAttempt,
  isCurrentOpenAttempt,
  openChildHistory,
} from './childRuntimeOpen.js';

function child() {
  return childStateFromRecord({
    parentAppSessionId: 'parent',
    childSessionId: 'child',
    providerSessionId: 'provider',
    role: 'worker',
    status: 'paused',
    modelId: 'model-default',
    transcriptAvailable: true,
    updatedAt: 1,
  });
}

function parentWith(open?: ChildOpenAttempt): ParentChildSessions {
  const state = child();
  return {
    parentAppSessionId: 'parent',
    generation: 1,
    lease: {} as ParentChildSessions['lease'],
    children: new Map([[state.identity.childSessionId, state]]),
    pendingSpawns: new Map(),
    openAttempts: open ? new Map([[state.identity.childSessionId, open]]) : new Map(),
    reservedOpenSlots: new Set(),
    runtimeQueue: [],
    closing: false,
  };
}

test('awaitOpenStep yields cancelled when the attempt is cancelled first', async () => {
  const parent = parentWith();
  const attempt = beginOpenAttempt(parent, 'child');
  let settled = false;
  const operation = new Promise<string>((resolve) => {
    setImmediate(() => {
      settled = true;
      resolve('late');
    });
  });
  attempt.cancel();
  const result = await awaitOpenStep(attempt, operation);
  assert.equal(result, CHILD_OPEN_CANCELLED);
  await operation;
  assert.equal(settled, true);
});

test('awaitOpenStep still cleans a late load after cancellation', async () => {
  const parent = parentWith();
  const attempt = beginOpenAttempt(parent, 'child');
  const cleaned: string[] = [];
  const operation = new Promise<string>((resolve) => {
    setImmediate(() => resolve('session'));
  });
  attempt.cancel();
  const result = await awaitOpenStep(attempt, operation, (value) => {
    cleaned.push(value);
  });
  assert.equal(result, CHILD_OPEN_CANCELLED);
  await operation;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(cleaned, ['session']);
});

test('finishOpenAttempt ignores a stale attempt and arms only the current one', () => {
  const parent = parentWith();
  const first = beginOpenAttempt(parent, 'child');
  const second = beginOpenAttempt(parent, 'child');
  let finished = 0;
  finishOpenAttempt(parent, 'child', first, () => {
    finished += 1;
  });
  assert.equal(parent.openAttempts.get('child'), second);
  assert.equal(finished, 0);
  finishOpenAttempt(parent, 'child', second, () => {
    finished += 1;
  });
  assert.equal(parent.openAttempts.has('child'), false);
  assert.equal(finished, 1);
});

test('isCurrentOpenAttempt is false once cancelled, completed, or replaced', () => {
  const parent = parentWith();
  const state = parent.children.get('child');
  assert.ok(state);
  const attempt = beginOpenAttempt(parent, 'child');
  const current = () => true;
  assert.equal(isCurrentOpenAttempt(parent, state, attempt, current), true);

  attempt.isCancelled = true;
  assert.equal(isCurrentOpenAttempt(parent, state, attempt, current), false);
  attempt.isCancelled = false;

  state.runtime = { session: {} as never, generation: 1, lastUsedAt: 0 };
  assert.equal(isCurrentOpenAttempt(parent, state, attempt, current), false);
  state.runtime = undefined;

  state.closeWhenIdle = true;
  assert.equal(isCurrentOpenAttempt(parent, state, attempt, current), false);
  state.closeWhenIdle = false;

  assert.equal(
    isCurrentOpenAttempt(parent, state, attempt, () => false),
    false,
  );
});

test('cancelOpenAttempts cancels every in-flight open and closes provisionals', async () => {
  const parent = parentWith();
  const attempt = beginOpenAttempt(parent, 'child');
  let closed = 0;
  attempt.provisionalSession = {
    close: () => {
      closed += 1;
      return Promise.resolve();
    },
  } as never;
  await cancelOpenAttempts(parent);
  assert.equal(attempt.isCancelled, true);
  assert.equal(parent.openAttempts.size, 0);
  assert.equal(closed, 1);
  await cancelOpenAttempts(parent);
  assert.equal(closed, 1);
});

test('openChildHistory reports unavailable when no transcript exists', () => {
  const errors: string[] = [];
  openChildHistory(
    {
      parentAppSessionId: 'parent',
      childSessionId: 'child',
      role: 'worker',
      status: 'completed',
      modelId: 'model-default',
      transcriptAvailable: false,
      updatedAt: 1,
    },
    'open',
    'req-1',
    {
      emitError: (_identity, _op, _id, code) => {
        errors.push(code);
      },
      emit: () => undefined,
      loadChildHistory: () => undefined,
    },
  );
  assert.deepEqual(errors, ['child.runtime_unavailable']);
});

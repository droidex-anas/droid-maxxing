import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationDeliveryReceipt } from '../automations/types.js';
import { ProjectWakeQueue } from './ProjectWakeQueue.js';
import type { Project, ThreadMessage } from './types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function message(id: string, target = 'main'): ThreadMessage {
  return { id, from: 'worker', to: target, kind: 'result', text: id };
}
function project(id = 'project'): Project {
  return {
    id,
    title: id,
    paused: false,
    wakesLeft: 20,
    launching: 0,
    threads: [
      { appSessionId: 'main', title: 'Main', reply: '', waiting: false },
      {
        appSessionId: 'worker',
        ownerAppSessionId: 'main',
        title: 'Worker',
        reply: '',
        waiting: false,
      },
    ],
    pending: [message('first')],
  };
}

test('acceptance removes only its claim and holds the turn slot until completion', async () => {
  const state = project();
  const admitted = deferred<AutomationDeliveryReceipt>();
  const finished = deferred<void>();
  const calls: string[] = [];
  let saved: Project | undefined;
  const queue = new ProjectWakeQueue(
    {
      deliver: async (_target, prompt) => {
        calls.push(prompt);
        if (calls.length === 1) return admitted.promise;
        return { status: 'accepted', settled: Promise.resolve() };
      },
    },
    async () => {
      saved = structuredClone(state);
    },
    (_project, error) => {
      throw error;
    },
  );
  queue.kick(state);
  await tick();
  assert.equal(saved?.delivery?.state, 'sending');
  state.pending.push(message('arrived-during-admission'));
  queue.kick(state);
  admitted.resolve({ status: 'accepted', settled: finished.promise });
  await tick();
  assert.deepEqual(
    state.pending.map((item) => item.id),
    ['arrived-during-admission'],
  );
  queue.available(state, 'main');
  await tick();
  assert.equal(calls.length, 1, 'a live accepted turn still owns its slot');
  finished.resolve();
  await tick();
  await tick();
  assert.equal(calls.length, 2);
  assert.match(calls[1], /arrived-during-admission/);
  assert.doesNotMatch(calls[1], /"first"/);
  queue.close();
  await queue.flush();
});

test('availability arriving during an awaited busy receipt is not lost', async () => {
  const state = project();
  const receipt = deferred<AutomationDeliveryReceipt>();
  let calls = 0;
  const queue = new ProjectWakeQueue(
    {
      deliver: async () => {
        calls += 1;
        if (calls === 1) return receipt.promise;
        return { status: 'accepted', settled: Promise.resolve() };
      },
    },
    async () => {},
    (_project, error) => {
      throw error;
    },
  );
  queue.kick(state);
  await tick();
  queue.available(state, 'main');
  receipt.resolve({ status: 'busy', retryOn: 'target' });
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(state.wakesLeft, 19, 'busy admission is refunded');
  queue.close();
  await queue.flush();
});

test('unacknowledged delivery pauses with a retained claim instead of retrying', async () => {
  const state = project();
  let calls = 0;
  const queue = new ProjectWakeQueue(
    {
      deliver: async () => {
        calls += 1;
        return { status: 'unavailable', error: 'Delivery outcome unknown' };
      },
    },
    async () => {},
    (item, error) => {
      item.paused = true;
      item.error = String(error);
      if (item.delivery) item.delivery.state = 'uncertain';
    },
  );
  queue.kick(state);
  await tick();
  queue.available(state, 'main');
  queue.capacityChanged([state]);
  await tick();
  assert.equal(calls, 1);
  assert.equal(state.delivery?.state, 'uncertain');
  assert.equal(state.delivery?.messages[0]?.id, 'first');
  assert.equal(state.paused, true);
  queue.close();
  await queue.flush();
});

test('completed callbacks free the global limit of two accepted project turns', async () => {
  const states = [project('one'), project('two'), project('three')];
  states.forEach((item, index) => {
    item.pending[0].to = `main-${index}`;
  });
  const finished = deferred<void>();
  let calls = 0;
  const queue = new ProjectWakeQueue(
    {
      deliver: async () => {
        calls += 1;
        return { status: 'accepted', settled: finished.promise };
      },
    },
    async () => {},
    (_project, error) => {
      throw error;
    },
  );
  states.forEach((item) => queue.kick(item));
  await tick();
  await tick();
  assert.equal(calls, 2);
  finished.resolve();
  await tick();
  await tick();
  assert.equal(calls, 3);
  queue.close();
  await queue.flush();
});

test('explicit resume rechecks both target and capacity busy markers', async () => {
  for (const retryOn of ['target', 'capacity'] as const) {
    const state = project();
    let calls = 0;
    const queue = new ProjectWakeQueue(
      {
        deliver: async () => {
          calls += 1;
          if (calls === 1) return { status: 'busy', retryOn };
          return { status: 'accepted', settled: Promise.resolve() };
        },
      },
      () => Promise.resolve(),
      (_project, error) => {
        throw error;
      },
    );
    queue.kick(state);
    await tick();
    await tick();
    assert.equal(calls, 1);
    state.paused = true;
    queue.invalidate(state);
    state.paused = false;
    queue.invalidate(state);
    queue.kick(state);
    await tick();
    await tick();
    assert.equal(calls, 2, retryOn + ' must be rechecked on explicit resume');
    assert.equal(state.pending.length, 0);
    queue.close();
    await queue.flush();
  }
});

test('a cancelled admission cannot restore a busy marker after resume', async () => {
  const state = project();
  const admitted = deferred<AutomationDeliveryReceipt>();
  let calls = 0;
  const queue = new ProjectWakeQueue(
    {
      deliver: async () => {
        calls += 1;
        if (calls === 1) return admitted.promise;
        return { status: 'accepted', settled: Promise.resolve() };
      },
    },
    () => Promise.resolve(),
    (_project, error) => {
      throw error;
    },
  );
  queue.kick(state);
  await tick();
  state.paused = true;
  queue.invalidate(state);
  admitted.resolve({ status: 'busy', retryOn: 'target' });
  await tick();
  state.paused = false;
  queue.invalidate(state);
  queue.kick(state);
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(state.wakesLeft, 19);
  assert.equal(state.pending.length, 0);
  queue.close();
  await queue.flush();
});

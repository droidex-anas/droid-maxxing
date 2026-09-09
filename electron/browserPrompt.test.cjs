const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowserPromptController } = require('./browserPrompt.cjs');

function createFixture(overrides = {}) {
  const sent = [];
  const dismissed = [];
  const timers = [];
  let sequence = 0;
  const controller = createBrowserPromptController({
    isAvailable: overrides.isAvailable ?? (() => true),
    randomUUID: () => `prompt-${++sequence}`,
    send: (prompt) => sent.push(prompt),
    dismiss: overrides.dismiss ?? ((requestId) => dismissed.push(requestId)),
    logError: overrides.logError,
    maxQueuedPrompts: overrides.maxQueuedPrompts,
    now: overrides.now,
    timeoutMs: overrides.timeoutMs,
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });
  return { controller, dismissed, sent, timers };
}

const prompt = {
  kind: 'permission',
  title: 'Allow DROIDEX?',
  message: 'Allow exact-site access?',
  detail: 'The approval is scoped to https://example.com.',
  buttons: ['Allow once', 'Always allow', 'Cancel'],
  cancelId: 2,
};

test('prompts are serialized and only the exact active request can resolve', async () => {
  const { controller, sent } = createFixture();
  const first = controller.request(prompt);
  const second = controller.request(prompt);

  assert.equal(sent.length, 1);
  assert.equal(controller.resolve('wrong-id', 0), false);
  assert.equal(controller.resolve('prompt-1', 1), true);
  assert.deepEqual(await first, { response: 1 });
  assert.equal(sent[1].requestId, 'prompt-2');
  assert.equal(controller.resolve('prompt-2', 0), true);
  assert.deepEqual(await second, { response: 0 });
});

test('timeout and cancelAll settle with the declared cancel action', async () => {
  const { controller, timers } = createFixture();
  const timed = controller.request(prompt);
  timers[0].callback();
  assert.deepEqual(await timed, { response: 2 });

  const active = controller.request(prompt);
  const queued = controller.request(prompt);
  controller.cancelAll();
  assert.deepEqual(await active, { response: 2 });
  assert.deepEqual(await queued, { response: 2 });
});

test('invalid prompts and response indexes fail closed', async () => {
  const { controller } = createFixture();
  assert.throws(() => controller.request({ ...prompt, cancelId: 9 }), /cancel action/);
  const result = controller.request(prompt);
  assert.equal(controller.resolve('prompt-1', 9), false);
  controller.cancelAll();
  assert.deepEqual(await result, { response: 2 });
});

test('aborting one permission prompt closes only that prompt and advances the queue', async () => {
  const { controller, dismissed, sent } = createFixture();
  const abort = new AbortController();
  const first = controller.request(prompt, { signal: abort.signal });
  const second = controller.request(prompt);

  abort.abort();

  assert.deepEqual(await first, { response: 2 });
  assert.deepEqual(dismissed, ['prompt-1']);
  assert.equal(sent[1].requestId, 'prompt-2');
  assert.equal(controller.resolve('prompt-2', 0), true);
  assert.deepEqual(await second, { response: 0 });
});

test('a renderer dismissal failure still settles the prompt and advances the queue', async () => {
  const errors = [];
  const abort = new AbortController();
  const { controller, sent } = createFixture({
    dismiss: () => {
      throw new Error('renderer destroyed');
    },
    logError: (message, error) => errors.push({ message, error }),
  });
  const first = controller.request(prompt, { signal: abort.signal });
  const second = controller.request(prompt);

  assert.doesNotThrow(() => abort.abort());
  assert.deepEqual(await first, { response: 2 });
  assert.equal(sent[1].requestId, 'prompt-2');
  assert.equal(controller.resolve('prompt-2', 0), true);
  assert.deepEqual(await second, { response: 0 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /dismiss/i);
  assert.match(errors[0].error.message, /renderer destroyed/);
});

test('queued prompts expire from enqueue time without ever being displayed', async () => {
  let nowMs = 1_000;
  const { controller, dismissed, sent, timers } = createFixture({
    now: () => nowMs,
    timeoutMs: 50,
  });
  const active = controller.request(prompt);
  const queued = controller.request(prompt);

  nowMs = 1_051;
  timers[1].callback();
  assert.deepEqual(await queued, { response: 2 });
  assert.deepEqual(dismissed, []);
  assert.equal(sent.length, 1);

  controller.resolve('prompt-1', 0);
  assert.deepEqual(await active, { response: 0 });
  assert.equal(sent.length, 1);
});

test('the bounded prompt queue cancels overflow immediately', async () => {
  const { controller, sent, timers } = createFixture({ maxQueuedPrompts: 2 });
  const active = controller.request(prompt);
  const queuedOne = controller.request(prompt);
  const queuedTwo = controller.request(prompt);
  const overflow = controller.request(prompt);

  assert.deepEqual(await overflow, { response: 2 });
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 3);

  controller.cancelAll();
  assert.deepEqual(await active, { response: 2 });
  assert.deepEqual(await queuedOne, { response: 2 });
  assert.deepEqual(await queuedTwo, { response: 2 });
});

test('credential prompts move ahead of queued permissions without preempting the active prompt', async () => {
  const { controller, sent } = createFixture();
  const active = controller.request(prompt);
  const permission = controller.request({ ...prompt, title: 'Second permission' });
  const credential = controller.request({ ...prompt, kind: 'credential', title: 'Use passkey?' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'permission');
  controller.resolve('prompt-1', 0);
  assert.deepEqual(await active, { response: 0 });
  assert.equal(sent[1].kind, 'credential');

  controller.resolve('prompt-2', 0);
  assert.deepEqual(await credential, { response: 0 });
  assert.equal(sent[2].title, 'Second permission');
  controller.resolve('prompt-3', 2);
  assert.deepEqual(await permission, { response: 2 });
});

test('prompts fail closed while the renderer is unavailable', async () => {
  const { controller, sent } = createFixture({ isAvailable: () => false });
  const first = controller.request(prompt);
  const second = controller.request(prompt);

  assert.deepEqual(await first, { response: 2 });
  assert.deepEqual(await second, { response: 2 });
  assert.equal(sent.length, 0);
});

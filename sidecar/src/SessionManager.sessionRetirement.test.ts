import assert from 'node:assert/strict';
import test from 'node:test';

import type * as Protocol from './protocol.js';
import { writeProviderConversation } from './testing/historyCharacterizationSupport.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

function historicalSummary(
  appSessionId: string,
  providerSessionId: string,
): Protocol.SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function worker(
  parentAppSessionId: string,
  childSessionId: string,
  status: Protocol.ChildSessionSummary['status'],
): Protocol.ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status,
    modelId: 'model-default',
    transcriptAvailable: true,
    streamFidelity: 'state',
  };
}

const focusElsewhere = (h: SessionManagerTestContext): Promise<void> =>
  h.handle({ type: 'app.backgroundWork', tier: 'interactive', focusedAppSessionId: 'other' });

const focusOn = (h: SessionManagerTestContext, appSessionId: string): Promise<void> =>
  h.handle({ type: 'app.backgroundWork', tier: 'interactive', focusedAppSessionId: appSessionId });

async function openIdleSession(
  h: SessionManagerTestContext,
  clientRef: string,
): Promise<{ appSessionId: string; providerSessionId: string }> {
  await h.create({
    sessionPurpose: 'chat',
    clientRef,
    title: clientRef,
    goal: `first turn for ${clientRef}`,
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
  });
  const created = h.events.find(
    (event) => event.type === 'session.created' && event.clientRef === clientRef,
  );
  assert.ok(created?.type === 'session.created');
  await h.waitForIdle();
  return {
    appSessionId: created.session.appSessionId,
    providerSessionId: created.session.providerSessionId ?? created.session.appSessionId,
  };
}

const providerClosures = (h: SessionManagerTestContext): string[] =>
  h.calls
    .filter((call) => call.target === 'cleanup' && call.method === 'session.close')
    .map((call) => String(call.args[0]));

const appendedEvents = (
  h: SessionManagerTestContext,
): Extract<Protocol.ServerEvent, { type: 'event.appended' }>[] =>
  h.events.filter(
    (event): event is Extract<Protocol.ServerEvent, { type: 'event.appended' }> =>
      event.type === 'event.appended',
  );

test('a settled background session past the budget releases its provider process', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'idle');
    await focusElsewhere(h);

    await h.retireIdleSessionRuntimes();

    assert.deepEqual(providerClosures(h), [session.providerSessionId]);
    assert.equal(
      h.events.some(
        (event) => event.type === 'session.closed' && event.appSessionId === session.appSessionId,
      ),
      true,
      'the client must learn the runtime is gone',
    );
  } finally {
    await h.dispose();
  }
});

test('a settled background session inside the budget keeps its runtime', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 60 * 60_000 });
  try {
    await openIdleSession(h, 'recent');
    await focusElsewhere(h);

    await h.retireIdleSessionRuntimes();

    assert.deepEqual(providerClosures(h), [], 'the budget must not expire early');
  } finally {
    await h.dispose();
  }
});

test('the session the user is looking at keeps its runtime', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const visible = await openIdleSession(h, 'visible');
    const background = await openIdleSession(h, 'background');
    await focusOn(h, visible.appSessionId);

    await h.retireIdleSessionRuntimes();

    assert.deepEqual(providerClosures(h), [background.providerSessionId]);
  } finally {
    await h.dispose();
  }
});

test('nothing is retired until the renderer reports what is on screen', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    await openIdleSession(h, 'unknown-focus');

    await h.retireIdleSessionRuntimes();

    assert.deepEqual(providerClosures(h), []);
  } finally {
    await h.dispose();
  }
});

test('a session mid-turn is never retired, however long its runtime sat unused', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'busy');
    await focusElsewhere(h);
    const gate = h.provider.deferNextStream(session.providerSessionId);
    const sending = h.handle({
      type: 'session.send',
      appSessionId: session.appSessionId,
      text: 'keep working',
    });
    await h.provider.waitForPrompts(session.providerSessionId, 2);

    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [], 'an in-flight turn must never be retired');

    gate.resolve();
    await sending;
    await h.waitForIdle();

    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [session.providerSessionId]);
  } finally {
    await h.dispose();
  }
});

test('a session with a queued prompt is never retired', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'queued');
    await focusElsewhere(h);
    const gate = h.provider.deferNextStream(session.providerSessionId);
    const sending = h.handle({
      type: 'session.send',
      appSessionId: session.appSessionId,
      text: 'first',
    });
    await h.provider.waitForPrompts(session.providerSessionId, 2);
    await h.handle({
      type: 'session.send',
      appSessionId: session.appSessionId,
      text: 'queued behind it',
    });

    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), []);

    gate.resolve();
    await sending;
    await h.provider.waitForPrompts(session.providerSessionId, 3);
  } finally {
    await h.dispose();
  }
});

test('an idle session whose child agent is still working is never retired', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'parent');
    h.fixture.seedChildSessions([worker(session.appSessionId, 'worker-1', 'paused')]);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: session.appSessionId,
      childSessionId: 'worker-1',
      requestId: 'open-worker-1',
    });
    await focusElsewhere(h);

    // The parent's own turn is idle: only the child is working.
    const gate = h.provider.deferNextStream('worker-1');
    const sending = h.handle({
      type: 'child.send',
      parentAppSessionId: session.appSessionId,
      childSessionId: 'worker-1',
      text: 'keep working',
    });
    await h.provider.waitForPrompts('worker-1', 1);

    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [], 'retiring a parent would close its child subtree');

    gate.resolve();
    await sending;
    await h.waitForIdle();

    await h.retireIdleSessionRuntimes();
    assert.equal(
      providerClosures(h).includes(session.providerSessionId),
      true,
      'the parent becomes retirable once its children settle',
    );
  } finally {
    await h.dispose();
  }
});

test('a session with an embedded browser open is never retired', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'browsing');
    await h.handle({
      type: 'browser.open',
      appSessionId: session.appSessionId,
      url: 'https://example.test',
    });
    await focusElsewhere(h);

    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), []);

    await h.handle({ type: 'browser.close', appSessionId: session.appSessionId });
    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [session.providerSessionId]);
  } finally {
    await h.dispose();
  }
});

test('a session with an unapplied model choice is never retired', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'model-pending');
    await h.handle({
      type: 'settings.agent.update',
      appSessionId: session.appSessionId,
      agent: 'primary',
      modelId: 'model-alt',
    });
    await focusElsewhere(h);

    await h.retireIdleSessionRuntimes();

    assert.deepEqual(providerClosures(h), [], 'a pending model choice would be dropped by a close');
  } finally {
    await h.dispose();
  }
});

test('retirement tells the user why the runtime went away', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'explained');
    await focusElsewhere(h);
    await h.retireIdleSessionRuntimes();

    const status = appendedEvents(h).find(
      ({ event }) =>
        event.appSessionId === session.appSessionId &&
        event.kind === 'status' &&
        /released after 30 minutes idle/.test(event.text ?? ''),
    );
    assert.ok(status, 'a retired session must leave a visible reason in its transcript');
  } finally {
    await h.dispose();
  }
});

test('a retired session reopens on the next prompt with its history intact', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'reopened');
    await focusElsewhere(h);
    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [session.providerSessionId]);

    await h.handle({ type: 'session.loadHistory', appSessionId: session.appSessionId });
    const history = h.events.find(
      (event): event is Extract<Protocol.ServerEvent, { type: 'session.history' }> =>
        event.type === 'session.history' && event.appSessionId === session.appSessionId,
    );
    assert.ok(history, 'a retired session must still serve its persisted transcript');
    assert.equal(history.mode, 'replace');

    await h.handle({ type: 'sessions.list' });
    const listed = h.events.findLast(
      (event): event is Extract<Protocol.ServerEvent, { type: 'sessions.list' }> =>
        event.type === 'sessions.list',
    );
    assert.equal(
      listed?.sessions.some((entry) => entry.appSessionId === session.appSessionId),
      true,
      'a retired session must stay in the sidebar',
    );

    await h.handle({
      type: 'session.send',
      appSessionId: session.appSessionId,
      text: 'back again',
    });
    await h.provider.waitForPrompts(session.providerSessionId, 1);

    assert.deepEqual(
      h.runtime.loadCalls.map((call) => call.sessionId),
      [session.providerSessionId],
      'the next prompt reloads the same provider session',
    );
    assert.deepEqual(h.provider.session(session.providerSessionId).prompts, ['back again']);
  } finally {
    await h.dispose();
  }
});

test('a prompt that lands while the runtime is being released still reaches the session', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'racing');
    writeProviderConversation(h.home, session.providerSessionId, 'racing');
    await focusElsewhere(h);

    const retiring = h.retireIdleSessionRuntimes();
    const sending = h.handle({
      type: 'session.send',
      appSessionId: session.appSessionId,
      text: 'sent mid-release',
    });
    await retiring;
    await sending;
    await h.provider.waitForPrompts(session.providerSessionId, 1);

    assert.deepEqual(
      h.runtime.loadCalls.map((call) => call.sessionId),
      [session.providerSessionId],
      'the send must wait for the release and reopen rather than vanish',
    );
    assert.deepEqual(h.provider.session(session.providerSessionId).prompts, ['sent mid-release']);
  } finally {
    await h.dispose();
  }
});

test('retirement never closes a runtime twice across explicit close and shutdown', async () => {
  const h = createSessionManagerTestContext({ sessionRuntimeIdleMs: 0 });
  try {
    const session = await openIdleSession(h, 'teardown');
    await focusElsewhere(h);
    await h.handle({ type: 'session.close', appSessionId: session.appSessionId });

    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [session.providerSessionId], 'no second close');

    await h.shutdown();
    await h.retireIdleSessionRuntimes();
    assert.deepEqual(providerClosures(h), [session.providerSessionId]);
  } finally {
    await h.dispose();
  }
});

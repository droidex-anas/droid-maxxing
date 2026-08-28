import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { writeProviderConversation } from './testing/historyCharacterizationSupport.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

const FORBIDDEN_NATIVE_KEYS = new Set(['providerSessionId', 'compactedFromProviderSessionIds']);

function assertNoNativeIdentityKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNativeIdentityKeys(entry, `${path}[${String(index)}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(
      FORBIDDEN_NATIVE_KEYS.has(key),
      false,
      `native identity key ${key} leaked at ${path}`,
    );
    assertNoNativeIdentityKeys(nested, `${path}.${key}`);
  }
}

function historicalSummary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: `Historical ${appSessionId}`,
    goal: '',
    cwd: '/repo',
    workspaceKind: 'folder',
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

test(
  'published ServerEvents never include providerSessionId or compactedFromProviderSessionIds keys',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'wire-scrub-create',
        title: 'Wire scrub',
        goal: 'hello',
        cwd: '/repo',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });
      await h.waitForIdle();

      const created = h.events.find((event) => event.type === 'session.created');
      assert.ok(created?.type === 'session.created');
      const appSessionId = created.session.appSessionId;
      assert.deepEqual(created.session.sessionRef, {
        id: 'provider-1',
        resumeCommand: "droid -r 'provider-1'",
      });
      assert.equal(created.session.sessionWebUrl, 'https://app.factory.ai/sessions/provider-1');

      await h.handle({
        type: 'session.updateSettings',
        appSessionId,
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'medium',
        }),
      });
      await h.handle({ type: 'sessions.list' });
      await h.handle({ type: 'session.resume', appSessionId });

      h.fixture.seedHistorySummaries([historicalSummary('app-hist', 'provider-hist')]);
      writeProviderConversation(h.home, 'provider-hist', 'Historical wire scrub');
      h.runtime.loadQueue.set('provider-hist', [
        new FakeFactorySession('provider-hist', {}, h.calls),
      ]);
      await h.handle({ type: 'session.resume', appSessionId: 'app-hist' });

      assert.ok(h.events.some((event) => event.type === 'sessions.list'));
      assert.ok(
        h.events.some(
          (event) =>
            event.type === 'session.created' && event.clientRef === `resume:${appSessionId}`,
        ),
      );
      const historicalCreated = h.events.find(
        (event) => event.type === 'session.created' && event.clientRef === 'resume:app-hist',
      );
      assert.ok(historicalCreated?.type === 'session.created');
      assert.deepEqual(historicalCreated.session.sessionRef, {
        id: 'provider-hist',
        resumeCommand: "droid -r 'provider-hist'",
      });

      for (const event of h.events) {
        const serialized: unknown = JSON.parse(JSON.stringify(event));
        assertNoNativeIdentityKeys(serialized, event.type);
      }
    } finally {
      await h.dispose();
    }
  },
);

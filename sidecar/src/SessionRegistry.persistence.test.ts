import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { SessionSummary } from './protocol.js';
import {
  SessionRegistry,
  liveBindingFromSummary,
  type RegisteredSession,
} from './SessionRegistry.js';
import { encodeDroidResumeState } from './providers/droid/DroidModeMapping.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';

interface LiveSession extends RegisteredSession {
  marker: string;
}

function createHarness(t: TestContext, rows: SessionSummary[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-registry-persist-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const row of rows) seedStoredSession(store, row);
  const registry = new SessionRegistry<LiveSession>({
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
    sessionStore: store,
  });
  return { store, registry };
}

function seedStoredSession(store: SessionStore, liveSummary: SessionSummary): void {
  store.createProvisional(
    {
      appSessionId: liveSummary.appSessionId,
      clientRef: `ref-${liveSummary.appSessionId}`,
      summary: liveSummary,
    },
    liveSummary.updatedAt,
  );
  const previous = liveSummary.compactedFromProviderSessionIds ?? [];
  const chain = liveSummary.providerSessionId
    ? [...previous, liveSummary.providerSessionId]
    : [...previous];
  if (chain.length > 0) {
    const [first, ...rest] = chain;
    store.bindInitialProviderRuntime(
      liveSummary.appSessionId,
      0,
      first,
      encodeDroidResumeState(first),
    );
    let generation = 1;
    for (const next of rest) {
      store.replaceProviderRuntime(
        liveSummary.appSessionId,
        generation,
        next,
        encodeDroidResumeState(next),
      );
      generation += 1;
    }
  }
  store.markStarted(liveSummary.appSessionId, liveSummary.updatedAt);
}

function summary(
  appSessionId: string,
  providerSessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/repo',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('stored summaries are listed and resolved without a live runtime', (t) => {
  const current = summary('app', 'provider-current', {
    compactedFromProviderSessionIds: ['provider-old'],
  });
  const { registry, store } = createHarness(t, [current]);

  assert.equal(registry.resolveSummary('app')?.appSessionId, 'app');
  assert.equal(registry.listSummaries().sessions[0]?.appSessionId, 'app');
  assert.equal(store.get('app')?.binding.providerSessionId, 'provider-current');
});

test('reanchored stored cwd is readable from SessionStore', (t) => {
  const source = summary('app', 'provider', { cwd: '/repo/.worktrees/feature' });
  const { registry, store } = createHarness(t, [source]);

  assert.deepEqual(
    registry.reanchorHistoricalCwd('/repo/.worktrees/feature', '/repo').map((item) => item.cwd),
    ['/repo'],
  );
  assert.equal(registry.resolveSummary('app')?.cwd, '/repo');
  assert.equal(store.get('app')?.summary.cwd, '/repo');
});

test('stored provider replacement updates the SessionStore runtime binding', (t) => {
  const source = summary('app', 'provider-current', {
    compactedFromProviderSessionIds: ['provider-old'],
  });
  const { registry, store } = createHarness(t, [source]);

  registry.replaceProvider('app', 'provider-next');

  assert.equal(registry.resolveSummary('app')?.appSessionId, 'app');
  assert.equal(store.get('app')?.binding.providerSessionId, 'provider-next');
});

test('Mission Control rows are listed from SessionStore', (t) => {
  const mission = summary('mission-one', 'mission-provider-one', {
    sessionPurpose: 'mission-control',
  });
  const { registry } = createHarness(t, [mission]);

  assert.equal(registry.listSummaries().sessions[0]?.appSessionId, 'mission-one');
  assert.equal(registry.listSummaries().sessions[0]?.sessionPurpose, 'mission-control');
});

test('unregister removes the live session while SessionStore keeps the row', (t) => {
  const { registry } = createHarness(t, [summary('app', 'provider')]);
  const live = {
    marker: 'live',
    summary: summary('app', 'provider'),
    binding: liveBindingFromSummary(summary('app', 'provider')),
  };
  registry.register(live);

  assert.equal(registry.unregister('app'), live);
  assert.equal(registry.getLive('app'), undefined);
  assert.equal(registry.resolveSummary('app')?.appSessionId, 'app');
  assert.equal(registry.listSummaries().sessions[0]?.appSessionId, 'app');
});

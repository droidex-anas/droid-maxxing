import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { BridgeFeature, SessionSummary } from './protocol.js';
import {
  SessionRegistry,
  liveBindingFromSummary,
  type RegisteredSession,
  type SessionRegistryDependencies,
} from './SessionRegistry.js';
import type { ProviderBinding, SessionStore as SessionStoreApi } from './persistence/SessionStore.js';
import { encodeDroidResumeState } from './providers/droid/DroidModeMapping.js';
import { droidSessionConfiguration, withProviderSelection } from './providers/providerIdentity.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';

interface TestLiveSession extends RegisteredSession {
  name: string;
  binding: ProviderBinding;
}

type RegistryStore = Pick<
  SessionStoreApi,
  'get' | 'list' | 'updateSummary' | 'replaceProviderRuntime'
>;

interface HarnessOptions {
  ordinary?: SessionSummary[];
  missionControl?: SessionSummary[];
  projectSummary?: SessionRegistryDependencies['projectSummary'];
  now?: () => number;
  onLiveProviderReplaced?: (providerSessionId: string) => void;
}

function createHarness(t: TestContext, options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-registry-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const persisted: SessionSummary[] = [];
  const published: SessionSummary[] = [];
  const persistTrace: string[] = [];
  let nextUpdateError: Error | undefined;

  const sessionStore: RegistryStore = {
    get: (appSessionId) => store.get(appSessionId),
    list: () => store.list(),
    updateSummary: (appSessionId, patch, updateOptions) => {
      if (nextUpdateError) {
        const error = nextUpdateError;
        nextUpdateError = undefined;
        throw error;
      }
      const result = store.updateSummary(appSessionId, patch, updateOptions);
      persistTrace.push('persist');
      persisted.push(copySummary(result.summary));
      return result;
    },
    replaceProviderRuntime: (appSessionId, expectedGeneration, providerSessionId, resumeState) =>
      store.replaceProviderRuntime(
        appSessionId,
        expectedGeneration,
        providerSessionId,
        resumeState,
      ),
  };

  for (const row of [...(options.ordinary ?? []), ...(options.missionControl ?? [])]) {
    seedStoredSession(store, row);
  }

  const dependencies: SessionRegistryDependencies = {
    projectSummary: options.projectSummary ?? ((summary) => copySummary(summary)),
    onSummaryUpdated: (summary) => {
      persistTrace.push('publish');
      published.push(copySummary(summary));
    },
    ...(options.onLiveProviderReplaced
      ? { onLiveProviderReplaced: options.onLiveProviderReplaced }
      : {}),
    now: options.now ?? (() => 100),
    sessionStore,
  };

  return {
    store,
    persisted,
    published,
    persistTrace,
    registry: new SessionRegistry<TestLiveSession>(dependencies),
    failNextPersist(error: Error) {
      nextUpdateError = error;
    },
    resetPersistTrace() {
      persisted.length = 0;
      persistTrace.length = 0;
    },
  };
}

function seedStoredSession(store: SessionStore, summary: SessionSummary): void {
  store.createProvisional(
    {
      appSessionId: summary.appSessionId,
      clientRef: `ref-${summary.appSessionId}`,
      summary,
    },
    summary.updatedAt,
  );
  const previous = summary.compactedFromProviderSessionIds ?? [];
  const chain = summary.providerSessionId
    ? [...previous, summary.providerSessionId]
    : [...previous];
  if (chain.length > 0) {
    const [first, ...rest] = chain;
    store.bindInitialProviderRuntime(
      summary.appSessionId,
      0,
      first,
      encodeDroidResumeState(first),
    );
    let generation = 1;
    for (const next of rest) {
      store.replaceProviderRuntime(
        summary.appSessionId,
        generation,
        next,
        encodeDroidResumeState(next),
      );
      generation += 1;
    }
  }
  store.markStarted(summary.appSessionId, summary.updatedAt);
}

function live(summary: SessionSummary): TestLiveSession {
  return { name: summary.title, summary, binding: liveBindingFromSummary(summary) };
}

function summary(appSessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    workspaceKind: 'folder',
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

function copySummary(value: Readonly<SessionSummary>): SessionSummary {
  return {
    ...value,
    ...(value.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...value.compactedFromProviderSessionIds] }
      : {}),
    features: value.features.map(copyFeature),
  };
}

function copyFeature(feature: BridgeFeature): BridgeFeature {
  return {
    ...feature,
    preconditions: [...feature.preconditions],
    expectedBehavior: [...feature.expectedBehavior],
    verificationSteps: [...feature.verificationSteps],
    ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
  };
}

function feature(id: string): BridgeFeature {
  return {
    id,
    description: 'Keep nested summary state isolated',
    status: 'pending',
    skillName: 'registry',
    preconditions: ['source-precondition'],
    expectedBehavior: ['source-behavior'],
    verificationSteps: ['source-verification'],
    fulfills: ['source-requirement'],
  };
}

test('register persists once and live lookup is app-id only', (t) => {
  const firstSummary = summary('app-a', {
    providerSessionId: 'provider-a',
    compactedFromProviderSessionIds: ['provider-a-old'],
  });
  const directSummary = summary('provider-a', { providerSessionId: 'provider-b' });
  const { persisted, registry, store } = createHarness(t, {
    ordinary: [firstSummary, directSummary],
  });
  const first = live(firstSummary);
  const directAppId = live(directSummary);

  registry.register(first);
  registry.register(directAppId);

  assert.equal(registry.getLive('app-a'), first);
  assert.equal(registry.getLive('provider-a-old'), undefined);
  assert.equal(registry.getLive('provider-a'), directAppId);
  assert.equal(registry.resolveSummary('provider-a-old')?.appSessionId, 'app-a');
  assert.deepEqual(
    persisted.map((row) => row.appSessionId),
    ['app-a', 'provider-a'],
  );
  assert.equal(store.get('app-a')?.summary.appSessionId, 'app-a');
  assert.equal(store.get('provider-a')?.summary.appSessionId, 'provider-a');
});

test('register rejects a runtime child shape at the top-level boundary', (t) => {
  const { persisted, registry } = createHarness(t);
  const child = live(summary('child-shape'));
  Reflect.set(child.summary, 'role', 'worker');

  assert.throws(() => registry.register(child), /top-level sessions only/);
  assert.deepEqual(persisted, []);
  assert.equal(registry.getLive('child-shape'), undefined);
});

test('failed registration leaves the previous live identity intact', (t) => {
  const { failNextPersist, registry } = createHarness(t, {
    ordinary: [
      summary('stable', {
        providerSessionId: 'provider-previous',
        compactedFromProviderSessionIds: ['provider-old'],
      }),
    ],
  });
  const previous = live(
    summary('stable', {
      providerSessionId: 'provider-previous',
      compactedFromProviderSessionIds: ['provider-old'],
    }),
  );
  registry.register(previous);

  failNextPersist(new Error('persist failed'));
  assert.throws(
    () => registry.register(live(summary('stable', { providerSessionId: 'provider-replacement' }))),
    /persist failed/,
  );

  assert.equal(registry.getLive('stable'), previous);
  assert.equal(registry.getLive('provider-previous'), undefined);
  assert.equal(registry.getLive('provider-old'), undefined);
  assert.equal(registry.getLive('provider-replacement'), undefined);
});

test('updateSummary persists canonical state before one publication and protects identity', (t) => {
  const { persistTrace, published, registry, resetPersistTrace, store } = createHarness(t, {
    now: () => 42,
    ordinary: [
      summary('stable-app', {
        providerSessionId: 'provider-current',
        compactedFromProviderSessionIds: ['provider-old'],
        missionId: 'mission-stable',
      }),
    ],
  });
  const session = live(
    summary('stable-app', {
      providerSessionId: 'provider-current',
      compactedFromProviderSessionIds: ['provider-old'],
      missionId: 'mission-stable',
    }),
  );
  registry.register(session);
  resetPersistTrace();

  const unsafePatch: Partial<SessionSummary> = {
    appSessionId: 'changed-app',
    providerSessionId: 'changed-provider',
    compactedFromProviderSessionIds: ['changed-alias'],
    missionId: 'changed-mission',
    title: 'Updated title',
    updatedAt: 999,
  };
  const updated = registry.updateSummary('stable-app', unsafePatch);

  assert.equal(updated?.appSessionId, 'stable-app');
  assert.equal(updated && 'providerSessionId' in updated, false);
  assert.equal(updated && 'compactedFromProviderSessionIds' in updated, false);
  assert.equal(updated?.sessionWebUrl, 'https://app.factory.ai/sessions/provider-current');
  assert.equal(session.binding.providerSessionId, 'provider-current');
  assert.deepEqual(session.binding.previousProviderSessionIds, ['provider-old']);
  assert.equal(updated?.missionId, 'mission-stable');
  assert.equal(updated?.title, 'Updated title');
  assert.equal(updated?.updatedAt, 42);
  assert.deepEqual(persistTrace, ['persist', 'publish']);
  assert.equal(store.get('stable-app')?.binding.providerSessionId, 'provider-current');
  assert.equal(store.get('stable-app')?.summary.title, 'Updated title');
  assert.equal(published[0]?.sessionWebUrl, 'https://app.factory.ai/sessions/provider-current');
  assert.equal(published[0] && 'providerSessionId' in published[0], false);
  assert.equal(registry.getLive('changed-app'), undefined);
  assert.equal(registry.getLive('provider-old'), undefined);
  assert.equal(registry.getLive('stable-app'), session);
});

test('updateSummary with touchActivity false keeps the activity timestamp', (t) => {
  const { persistTrace, published, registry, resetPersistTrace, store } = createHarness(t, {
    now: () => 42,
    ordinary: [summary('stable-app', { updatedAt: 7, tokensIn: 1 })],
  });
  const session = live(summary('stable-app', { updatedAt: 7, tokensIn: 1 }));
  registry.register(session);
  resetPersistTrace();

  const updated = registry.updateSummary(
    'stable-app',
    { tokensIn: 500, contextTokens: 128, updatedAt: 999 },
    { touchActivity: false },
  );

  // Telemetry must not move updatedAt: the renderer derives sidebar ordering
  // and the unread marker from it, so passive refreshes would otherwise mark
  // a viewed session as unread again.
  assert.equal(updated?.tokensIn, 500);
  assert.equal(updated?.contextTokens, 128);
  assert.equal(updated?.updatedAt, 7);
  assert.deepEqual(persistTrace, ['persist', 'publish']);
  assert.equal(store.get('stable-app')?.summary.tokensIn, 500);
  assert.equal(published[0]?.tokensIn, 500);
});

test('failed summary persistence leaves live state unchanged and unpublished', (t) => {
  const { failNextPersist, published, registry } = createHarness(t, {
    now: () => 42,
    ordinary: [summary('stable-app', { title: 'Original title' })],
  });
  const session = live(summary('stable-app', { title: 'Original title' }));
  registry.register(session);
  failNextPersist(new Error('persist failed'));

  assert.throws(
    () => registry.updateSummary('stable-app', { title: 'Uncommitted title' }),
    /persist failed/,
  );

  assert.equal(session.summary.title, 'Original title');
  assert.equal(session.summary.updatedAt, 1);
  assert.equal(registry.getCanonicalSummary('stable-app')?.title, 'Original title');
  assert.deepEqual(published, []);
});

test('reanchorHistoricalCwd moves idle sessions and preserves nested directories', (t) => {
  const historical = [
    summary('at-root', { cwd: '/repo/.worktrees/feature', updatedAt: 7 }),
    summary('nested', { cwd: '/repo/.worktrees/feature/packages/app', updatedAt: 8 }),
    summary('sibling', { cwd: '/repo/.worktrees/feature-next', updatedAt: 9 }),
  ];
  const { persisted, published, registry, store } = createHarness(t, { ordinary: historical });

  const updated = registry.reanchorHistoricalCwd('/repo/.worktrees/feature', '/repo');

  assert.deepEqual(
    updated.map((session) => [session.appSessionId, session.cwd, session.updatedAt]),
    [
      ['at-root', '/repo', 7],
      ['nested', '/repo/packages/app', 8],
    ],
  );
  assert.equal(registry.resolveSummary('at-root')?.cwd, '/repo');
  assert.equal(registry.resolveSummary('nested')?.cwd, '/repo/packages/app');
  assert.equal(registry.resolveSummary('sibling')?.cwd, '/repo/.worktrees/feature-next');
  assert.deepEqual(published, updated);
  assert.deepEqual(
    persisted.map((session) => [session.appSessionId, session.cwd, session.updatedAt]),
    [
      ['at-root', '/repo', 7],
      ['nested', '/repo/packages/app', 8],
    ],
  );
  assert.equal(store.get('at-root')?.summary.cwd, '/repo');
  assert.equal(store.get('nested')?.summary.cwd, '/repo/packages/app');
  assert.equal(store.get('sibling')?.summary.cwd, '/repo/.worktrees/feature-next');
});

test('reanchorHistoricalCwd refuses to move a worktree used by a live session', (t) => {
  const historical = summary('historical', { cwd: '/repo/.worktrees/feature' });
  const { persisted, published, registry, resetPersistTrace } = createHarness(t, {
    ordinary: [historical],
  });
  registry.register(live(summary('live', { cwd: '/repo/.worktrees/feature/subdir' })));
  resetPersistTrace();

  assert.throws(
    () => registry.reanchorHistoricalCwd('/repo/.worktrees/feature', '/repo'),
    /live session is still using/i,
  );
  assert.deepEqual(persisted, []);
  assert.deepEqual(published, []);
  assert.equal(registry.resolveSummary('historical')?.cwd, '/repo/.worktrees/feature');
});

test('replaceProvider retains the alias chain and supports live and stored sessions', (t) => {
  let timestamp = 10;
  const retiredProviders: string[] = [];
  const historical = summary('historical-app', {
    providerSessionId: 'historical-provider',
    compactedFromProviderSessionIds: ['historical-provider-old'],
  });
  const { persistTrace, published, registry, resetPersistTrace, store } = createHarness(t, {
    ordinary: [
      historical,
      summary('live-app', {
        providerSessionId: 'live-provider',
        compactedFromProviderSessionIds: ['live-provider-old'],
      }),
    ],
    now: () => timestamp++,
    onLiveProviderReplaced: (providerSessionId) => {
      retiredProviders.push(providerSessionId);
    },
  });
  const session = live(
    summary('live-app', {
      providerSessionId: 'live-provider',
      compactedFromProviderSessionIds: ['live-provider-old'],
    }),
  );
  registry.register(session);
  resetPersistTrace();

  const unchanged = registry.replaceProvider('live-app', 'live-provider');

  assert.equal(unchanged, session.summary);
  assert.deepEqual(persistTrace, []);
  assert.equal(published.length, 0);

  const liveUpdated = registry.replaceProvider('live-app', 'live-provider-next', {
    title: 'Live compacted',
  });

  assert.equal(liveUpdated?.providerSessionId, 'live-provider-next');
  assert.deepEqual(liveUpdated?.compactedFromProviderSessionIds, [
    'live-provider-old',
    'live-provider',
  ]);
  assert.equal(liveUpdated?.updatedAt, 1);
  assert.equal(registry.getLive('live-app'), session);
  assert.equal(registry.getLive('live-provider-next'), undefined);
  assert.equal(session.binding.providerSessionId, 'live-provider-next');
  assert.equal(registry.isCurrentLiveProvider('live-provider-next'), true);
  assert.equal(registry.isCurrentLiveProvider('live-provider'), false);
  assert.deepEqual(retiredProviders, ['live-provider']);
  assert.equal(
    registry.resolveSummary('live-app')?.sessionWebUrl,
    'https://app.factory.ai/sessions/live-provider-next',
  );
  assert.equal(
    registry.resolveSummary('live-app') &&
      'providerSessionId' in (registry.resolveSummary('live-app') ?? {}),
    false,
  );

  const historicalUpdated = registry.replaceProvider('historical-app', 'historical-provider-next');

  assert.equal(historicalUpdated?.appSessionId, 'historical-app');
  assert.equal(historicalUpdated?.providerSessionId, 'historical-provider-next');
  assert.equal(historicalUpdated?.updatedAt, 1);
  assert.equal(registry.getLive('historical-provider-next'), undefined);
  assert.equal(registry.resolveSummary('historical-app')?.appSessionId, 'historical-app');
  assert.equal(store.get('historical-app')?.binding.providerSessionId, 'historical-provider-next');
  assert.deepEqual(
    retiredProviders,
    ['live-provider'],
    'stored swaps do not retire live files',
  );
  assert.deepEqual(persistTrace, ['persist', 'publish', 'persist', 'persist', 'publish']);
  assert.equal(published.length, 2);
});

test('failed provider replacement preserves the live summary and aliases', (t) => {
  const { failNextPersist, published, registry } = createHarness(t, {
    now: () => 42,
    ordinary: [
      summary('stable-app', {
        providerSessionId: 'provider-current',
        compactedFromProviderSessionIds: ['provider-old'],
      }),
    ],
  });
  const session = live(
    summary('stable-app', {
      providerSessionId: 'provider-current',
      compactedFromProviderSessionIds: ['provider-old'],
    }),
  );
  registry.register(session);
  failNextPersist(new Error('persist failed'));

  assert.throws(
    () => registry.replaceProvider('stable-app', 'provider-next', { title: 'Uncommitted' }),
    /persist failed/,
  );

  assert.equal(session.summary.providerSessionId, 'provider-current');
  assert.equal(session.binding.providerSessionId, 'provider-current');
  assert.equal(session.summary.title, 'stable-app');
  assert.equal(registry.getLive('stable-app'), session);
  assert.equal(registry.getLive('provider-current'), undefined);
  assert.equal(registry.getLive('provider-next'), undefined);
  assert.deepEqual(published, []);
});

test('resolve and list project copies after store and live merging', (t) => {
  const ordinary = [
    summary('ordinary-only', { title: 'ordinary', updatedAt: 10 }),
    summary('mission-wins', {
      providerSessionId: 'mission-provider',
      sessionPurpose: 'mission-control',
      title: 'mission',
      updatedAt: 50,
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    }),
    summary('live-wins', {
      providerSessionId: 'live-provider-old',
      title: 'ordinary live shadow',
      updatedAt: 30,
    }),
  ];
  const { persisted, published, registry } = createHarness(t, {
    ordinary,
    projectSummary: (canonical) => ({
      ...canonical,
      appSessionId: 'projected-app-id',
      providerSessionId: 'projected-provider-id',
      compactedFromProviderSessionIds: ['projected-alias'],
      missionId: 'projected-mission',
      title: `projected: ${canonical.title}`,
      configuration: {
        ...canonical.configuration,
        providerSelection: {
          ...canonical.configuration.providerSelection,
          modelId: 'projected-model',
        },
      },
    }),
  });
  const liveSession = live(
    summary('live-wins', {
      providerSessionId: 'live-provider',
      compactedFromProviderSessionIds: ['live-provider-old'],
      title: 'live',
      updatedAt: 70,
    }),
  );
  registry.register(liveSession);

  const listed = registry.listSummaries().sessions;
  const firstListed = listed[0];
  assert.ok(firstListed);

  assert.deepEqual(
    listed.map((item) => [item.appSessionId, item.title]),
    [
      ['live-wins', 'projected: live'],
      ['mission-wins', 'projected: mission'],
      ['ordinary-only', 'projected: ordinary'],
    ],
  );
  assert.equal(firstListed && 'providerSessionId' in firstListed, false);
  assert.equal(firstListed && 'compactedFromProviderSessionIds' in firstListed, false);
  assert.equal(firstListed.sessionWebUrl, 'https://app.factory.ai/sessions/live-provider');
  assert.equal(firstListed.missionId, undefined);
  assert.equal(firstListed.configuration.providerSelection.modelId, 'projected-model');
  assert.equal(liveSession.summary.title, 'live');
  assert.equal(liveSession.summary.configuration.providerSelection.modelId, 'model-default');

  const canonical = registry.getCanonicalSummary('live-provider-old');
  assert.equal(canonical?.title, 'live');
  assert.equal(canonical?.configuration.providerSelection.modelId, 'model-default');
  canonical?.compactedFromProviderSessionIds?.push('canonical-caller-mutation');
  assert.deepEqual(liveSession.summary.compactedFromProviderSessionIds, ['live-provider-old']);

  const resolved = registry.resolveSummary('live-provider-old');
  assert.equal(resolved?.appSessionId, 'live-wins');
  assert.equal(resolved && 'providerSessionId' in (resolved ?? {}), false);
  assert.equal(resolved?.sessionWebUrl, 'https://app.factory.ai/sessions/live-provider');
  assert.equal(resolved?.title, 'projected: live');
  assert.deepEqual(
    registry
      .listSummaries({ workspaceCwds: ['/workspace'] })
      .sessions.map((item) => item.appSessionId),
    ['live-wins', 'mission-wins', 'ordinary-only'],
  );

  registry.updateSummary('live-wins', { title: 'canonical update' });
  assert.equal(persisted.at(-1)?.title, 'canonical update');
  assert.equal(persisted.at(-1)?.configuration.providerSelection.modelId, 'model-default');
  assert.equal(published.at(-1)?.configuration.providerSelection.modelId, 'projected-model');
  assert.equal(published.at(-1)?.title, 'projected: canonical update');
  assert.equal(registry.resolveSummary('live-wins')?.title, 'projected: canonical update');
});

test('projected and caller-owned feature state cannot mutate canonical summaries', (t) => {
  const sourceFeature = feature('feature-a');
  const { registry } = createHarness(t, {
    projectSummary: (canonical) => {
      const projectedFeature = canonical.features[0];
      assert.ok(projectedFeature);
      projectedFeature.preconditions.push('projected-precondition');
      projectedFeature.fulfills?.push('projected-requirement');
      return copySummary(canonical);
    },
  });
  const liveSession = live(summary('isolated', { features: [sourceFeature] }));
  registry.register(liveSession);

  const resolved = registry.resolveSummary('isolated');
  const resolvedFeature = resolved?.features[0];
  assert.ok(resolvedFeature);
  assert.deepEqual(resolvedFeature.preconditions, [
    'source-precondition',
    'projected-precondition',
  ]);
  resolvedFeature.preconditions.push('resolved-caller-mutation');
  resolvedFeature.expectedBehavior.push('resolved-caller-mutation');

  const listedFeature = registry.listSummaries().sessions[0]?.features[0];
  assert.ok(listedFeature);
  listedFeature.verificationSteps.push('listed-caller-mutation');
  listedFeature.fulfills?.push('listed-caller-mutation');

  const canonical = registry.getCanonicalSummary('isolated');
  const canonicalFeature = canonical?.features[0];
  assert.ok(canonicalFeature);
  canonicalFeature.preconditions.push('canonical-caller-mutation');

  assert.deepEqual(liveSession.summary.features, [sourceFeature]);
  assert.deepEqual(registry.getCanonicalSummary('isolated')?.features, [sourceFeature]);
});

test('summary patches copy caller-owned feature state', (t) => {
  const { registry } = createHarness(t);
  registry.register(live(summary('patched')));

  const updatedFeature = feature('updated');
  registry.updateSummary('patched', { features: [updatedFeature] });
  updatedFeature.preconditions.push('caller-update');
  assert.deepEqual(registry.getCanonicalSummary('patched')?.features[0]?.preconditions, [
    'source-precondition',
  ]);

  const replacedFeature = feature('replaced');
  registry.replaceProvider('patched', 'provider-replaced', { features: [replacedFeature] });
  replacedFeature.expectedBehavior.push('caller-replacement');
  assert.deepEqual(registry.getCanonicalSummary('patched')?.features[0]?.expectedBehavior, [
    'source-behavior',
  ]);
});

test('workspace scoping lists only the requested folder', (t) => {
  const { registry } = createHarness(t, {
    ordinary: [
      summary('here', { title: 'in workspace', updatedAt: 20 }),
      summary('elsewhere', { cwd: '/other', title: 'other folder', updatedAt: 30 }),
    ],
  });

  assert.deepEqual(
    registry
      .listSummaries({ workspaceCwds: ['/workspace'] })
      .sessions.map((item) => [item.appSessionId, item.title]),
    [['here', 'in workspace']],
  );
});

test('snapshot permits sequential unregister without skipping sessions', (t) => {
  const { registry } = createHarness(t);
  const first = live(summary('first', { providerSessionId: 'provider-first' }));
  const second = live(
    summary('second', {
      providerSessionId: 'provider-second',
      compactedFromProviderSessionIds: ['provider-second-old'],
    }),
  );
  registry.register(first);
  registry.register(second);

  const snapshot = registry.liveSessionsSnapshot();
  assert.equal(registry.unregister('first'), first);
  assert.equal(registry.unregister('second'), second);

  assert.deepEqual(snapshot, [first, second]);
  assert.deepEqual(registry.liveSessionsSnapshot(), []);
  assert.equal(registry.getLive('first'), undefined);
  assert.equal(registry.getLive('second'), undefined);
  assert.equal(registry.unregister('missing'), undefined);
});

test('published summaries include a Droid web URL and sessionRef and omit native-id keys', (t) => {
  const { published, registry } = createHarness(t);
  registry.register(live(summary('app-droid', { providerSessionId: 'native-1' })));
  registry.updateSummary('app-droid', { title: 'Named' });
  const wire = published.at(-1);
  assert.equal(wire?.sessionWebUrl, 'https://app.factory.ai/sessions/native-1');
  assert.deepEqual(wire?.sessionRef, { id: 'native-1', resumeCommand: "droid -r 'native-1'" });
  assert.equal(wire && 'providerSessionId' in wire, false);
  assert.equal(wire && 'compactedFromProviderSessionIds' in wire, false);
});

test('published summaries omit sessionWebUrl and sessionRef for non-Droid providers', (t) => {
  const { published, registry } = createHarness(t);
  registry.register(
    live(
      summary('app-cursor', {
        providerSessionId: 'native-1',
        configuration: withProviderSelection(
          droidSessionConfiguration({
            modelId: 'model-default',
            interactionMode: 'auto',
            autonomy: 'low',
          }),
          { providerInstanceId: 'cursor' },
        ),
      }),
    ),
  );
  registry.updateSummary('app-cursor', { title: 'Cursor' });
  const wire = published.at(-1);
  assert.equal(wire?.sessionWebUrl, undefined);
  assert.equal(wire?.sessionRef, undefined);
  assert.equal(wire && 'providerSessionId' in wire, false);
  assert.equal(JSON.stringify(wire).includes('native-1'), false);
});

test('two live instances may share native id native-1 without colliding', (t) => {
  const { registry } = createHarness(t);
  const droid = live(summary('droid-app', { providerSessionId: 'native-1' }));
  const cursor = live(
    summary('cursor-app', {
      providerSessionId: 'native-1',
      configuration: withProviderSelection(
        droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
        { providerInstanceId: 'cursor' },
      ),
    }),
  );
  registry.register(droid);
  registry.register(cursor);
  assert.equal(registry.getLive('droid-app'), droid);
  assert.equal(registry.getLive('cursor-app'), cursor);
  assert.equal(registry.getLive('native-1'), undefined);
  assert.equal(droid.binding.providerSessionId, 'native-1');
  assert.equal(cursor.binding.providerSessionId, 'native-1');
});

test('registry dual-writes summary updates through SessionStore when a row exists', (t) => {
  const { registry, store } = createHarness(t);
  store.createProvisional({
    appSessionId: 'app-store',
    clientRef: 'ref-store',
    summary: summary('app-store'),
  });
  registry.register(live(summary('app-store', { providerSessionId: 'native-store' })));
  registry.updateSummary('app-store', { title: 'Stored title' });
  assert.equal(store.get('app-store')?.summary.title, 'Stored title');
  registry.replaceProvider('app-store', 'native-next');
  assert.equal(store.get('app-store')?.binding.providerSessionId, 'native-next');
  assert.equal(store.get('app-store')?.binding.runtimeGeneration, 1);
});

test('reanchorHistoricalCwd writes the new cwd through SessionStore', (t) => {
  const { registry, store } = createHarness(t, {
    ordinary: [summary('app-reanchor', { cwd: '/repo/.worktrees/feature' })],
  });
  const updated = registry.reanchorHistoricalCwd('/repo/.worktrees/feature', '/repo');
  assert.deepEqual(
    updated.map((session) => [session.appSessionId, session.cwd]),
    [['app-reanchor', '/repo']],
  );
  assert.equal(store.get('app-reanchor')?.summary.cwd, '/repo');
  assert.equal(store.list()[0]?.summary.cwd, '/repo');
});

test('invalidateAndUnregisterLive bumps generations and removes live sessions before awaits', (t) => {
  const { registry } = createHarness(t);
  const first = live(summary('first'));
  const second = live(summary('second'));
  const firstGeneration = first.binding.runtimeGeneration;
  registry.register(first);
  registry.register(second);
  const snapshot = registry.invalidateAndUnregisterLive();
  assert.equal(snapshot.length, 2);
  assert.equal(registry.getLive('first'), undefined);
  assert.equal(registry.getLive('second'), undefined);
  assert.equal(first.binding.runtimeGeneration, firstGeneration + 1);
  assert.equal(second.binding.runtimeGeneration, first.binding.runtimeGeneration);
  assert.deepEqual(snapshot.map((session) => session.summary.appSessionId).sort(), [
    'first',
    'second',
  ]);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { HistoricalSession } from './history.js';
import type { BridgeFeature, SessionSummary } from './protocol.js';
import {
  SessionRegistry,
  liveBindingFromSummary,
  type RegisteredSession,
  type SessionRegistryDependencies,
} from './SessionRegistry.js';
import type { ProviderBinding } from './persistence/SessionStore.js';
import { droidSessionConfiguration, withProviderSelection } from './providers/providerIdentity.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';

interface TestLiveSession extends RegisteredSession {
  name: string;
  binding: ProviderBinding;
}

class FakeHistory {
  readonly persisted: SessionSummary[] = [];
  readonly hiddenProviderIds = new Set<string>();
  readonly trace: string[] = [];
  summaryReadCount = 0;
  nextSyncError?: Error;
  nextDurabilityPending = false;
  private readonly patches = new Map<string, Partial<SessionSummary>>();

  syncSummaries(summaries: SessionSummary[]): boolean | undefined {
    const error = this.nextSyncError;
    delete this.nextSyncError;
    if (error) throw error;
    this.trace.push('persist');
    for (const summary of summaries) {
      const copy = copySummary(summary);
      this.persisted.push(copy);
      this.patches.set(summary.appSessionId, copy);
      if (summary.providerSessionId) this.patches.set(summary.providerSessionId, copy);
    }
    if (this.nextDurabilityPending) {
      this.nextDurabilityPending = false;
      return false;
    }
    return undefined;
  }

  summaryPatchesAndHidden(): {
    patches: Map<string, Partial<SessionSummary>>;
    hiddenProviderSessionIds: Set<string>;
  } {
    this.summaryReadCount += 1;
    return {
      patches: new Map(this.patches),
      hiddenProviderSessionIds: new Set(this.hiddenProviderIds),
    };
  }

  clearPatches(): void {
    this.patches.clear();
  }
}

interface HarnessOptions {
  ordinary?: SessionSummary[];
  missionControl?: SessionSummary[];
  loadOrdinarySessions?: SessionRegistryDependencies['loadOrdinarySessions'];
  loadMissionControlSessions?: SessionRegistryDependencies['loadMissionControlSessions'];
  projectSummary?: SessionRegistryDependencies['projectSummary'];
  now?: () => number;
  onLiveProviderReplaced?: (providerSessionId: string) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const history = new FakeHistory();
  const published: SessionSummary[] = [];
  const dependencies: SessionRegistryDependencies = {
    history,
    loadOrdinarySessions:
      options.loadOrdinarySessions ?? (() => historicalRows(options.ordinary ?? [])),
    loadMissionControlSessions:
      options.loadMissionControlSessions ?? (() => historicalRows(options.missionControl ?? [])),
    projectSummary: options.projectSummary ?? ((summary) => copySummary(summary)),
    onSummaryUpdated: (summary) => {
      history.trace.push('publish');
      published.push(copySummary(summary));
    },
    ...(options.onLiveProviderReplaced
      ? { onLiveProviderReplaced: options.onLiveProviderReplaced }
      : {}),
    now: options.now ?? (() => 100),
  };

  return {
    history,
    published,
    registry: new SessionRegistry<TestLiveSession>(dependencies),
  };
}

function historicalRows(summaries: SessionSummary[]): HistoricalSession[] {
  return summaries.map((summary) => ({ summary, progress: [] }));
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

function streamingStates(summaries: readonly SessionSummary[]): Array<boolean | undefined> {
  return summaries.map((value) => value.streaming);
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

test('register persists once and live lookup is app-id only', () => {
  const { history, published, registry } = createHarness();
  const first = live(
    summary('app-a', {
      providerSessionId: 'provider-a',
      compactedFromProviderSessionIds: ['provider-a-old'],
    }),
  );
  const directAppId = live(summary('provider-a', { providerSessionId: 'provider-b' }));

  registry.register(first);
  registry.register(directAppId);

  assert.equal(registry.getLive('app-a'), first);
  assert.equal(registry.getLive('provider-a-old'), undefined);
  assert.equal(registry.getLive('provider-a'), directAppId);
  assert.equal(registry.resolveSummary('provider-a-old')?.appSessionId, 'app-a');
  assert.deepEqual(
    history.persisted.map((persisted) => persisted.appSessionId),
    ['app-a', 'provider-a'],
  );
  assert.equal(published.length, 0);
});

test('register rejects a runtime child shape at the top-level boundary', () => {
  const { history, registry } = createHarness();
  const child = live(summary('child-shape'));
  Reflect.set(child.summary, 'role', 'worker');

  assert.throws(() => registry.register(child), /top-level sessions only/);
  assert.deepEqual(history.persisted, []);
  assert.equal(registry.getLive('child-shape'), undefined);
});

test('failed registration leaves the previous live identity intact', () => {
  const { history, registry } = createHarness();
  const previous = live(
    summary('stable', {
      providerSessionId: 'provider-previous',
      compactedFromProviderSessionIds: ['provider-old'],
    }),
  );
  registry.register(previous);

  history.nextSyncError = new Error('persist failed');
  assert.throws(
    () => registry.register(live(summary('stable', { providerSessionId: 'provider-replacement' }))),
    /persist failed/,
  );

  assert.equal(registry.getLive('stable'), previous);
  assert.equal(registry.getLive('provider-previous'), undefined);
  assert.equal(registry.getLive('provider-old'), undefined);
  assert.equal(registry.getLive('provider-replacement'), undefined);
});

test('updateSummary persists canonical state before one publication and protects identity', () => {
  const { history, published, registry } = createHarness({ now: () => 42 });
  const session = live(
    summary('stable-app', {
      providerSessionId: 'provider-current',
      compactedFromProviderSessionIds: ['provider-old'],
      missionId: 'mission-stable',
    }),
  );
  registry.register(session);
  history.persisted.length = 0;
  history.trace.length = 0;

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
  assert.deepEqual(history.trace, ['persist', 'publish']);
  assert.equal(history.persisted[0]?.providerSessionId, 'provider-current');
  assert.equal(published[0]?.sessionWebUrl, 'https://app.factory.ai/sessions/provider-current');
  assert.equal(published[0] && 'providerSessionId' in published[0], false);
  assert.equal(registry.getLive('changed-app'), undefined);
  assert.equal(registry.getLive('provider-old'), undefined);
  assert.equal(registry.getLive('stable-app'), session);
});

test('updateSummary with touchActivity false keeps the activity timestamp', () => {
  const { history, published, registry } = createHarness({ now: () => 42 });
  const session = live(summary('stable-app', { updatedAt: 7, tokensIn: 1 }));
  registry.register(session);
  history.persisted.length = 0;
  history.trace.length = 0;

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
  assert.deepEqual(history.trace, ['persist', 'publish']);
  assert.equal(history.persisted[0]?.tokensIn, 500);
  assert.equal(published[0]?.tokensIn, 500);
});

test('failed summary persistence leaves live state unchanged and unpublished', () => {
  const { history, published, registry } = createHarness({ now: () => 42 });
  const session = live(summary('stable-app', { title: 'Original title' }));
  registry.register(session);
  history.nextSyncError = new Error('persist failed');

  assert.throws(
    () => registry.updateSummary('stable-app', { title: 'Uncommitted title' }),
    /persist failed/,
  );

  assert.equal(session.summary.title, 'Original title');
  assert.equal(session.summary.updatedAt, 1);
  assert.equal(registry.getCanonicalSummary('stable-app')?.title, 'Original title');
  assert.deepEqual(published, []);
});

test('a retained settlement publishes only after durability recovery', () => {
  const { history, published, registry } = createHarness();
  const session = live(summary('durable-app', { streaming: true, phase: 'running' }));
  registry.register(session);
  history.trace.length = 0;
  published.length = 0;
  history.nextDurabilityPending = true;

  const pending = registry.updateSummary('durable-app', {
    streaming: false,
    phase: 'paused',
  });

  assert.equal(pending?.streaming, false);
  assert.equal(session.summary.streaming, false, 'the owner advances its internal state');
  assert.equal(
    registry.listSummaries().sessions[0]?.streaming,
    true,
    'renderer list stays durable',
  );
  assert.deepEqual(published, []);

  registry.retryPendingDurability();
  assert.equal(registry.listSummaries().sessions[0]?.streaming, false);
  assert.deepEqual(streamingStates(published), [false]);
});

test('new live state supersedes a held settlement without replaying it later', () => {
  const { history, published, registry } = createHarness();
  const session = live(summary('continued-app', { streaming: true, phase: 'running' }));
  registry.register(session);
  published.length = 0;
  history.nextDurabilityPending = true;
  registry.updateSummary('continued-app', { streaming: false, phase: 'paused' });

  registry.updateSummary('continued-app', { streaming: true, phase: 'running' });
  registry.retryPendingDurability();

  assert.deepEqual(streamingStates(published), [true]);
  assert.equal(registry.listSummaries().sessions[0]?.streaming, true);
});

test('reanchorHistoricalCwd moves idle sessions and preserves nested directories', () => {
  const historical = [
    summary('at-root', { cwd: '/repo/.worktrees/feature', updatedAt: 7 }),
    summary('nested', { cwd: '/repo/.worktrees/feature/packages/app', updatedAt: 8 }),
    summary('sibling', { cwd: '/repo/.worktrees/feature-next', updatedAt: 9 }),
  ];
  const { history, published, registry } = createHarness({ ordinary: historical });

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
    history.persisted.map((session) => [session.appSessionId, session.cwd, session.updatedAt]),
    [
      ['at-root', '/repo', 7],
      ['nested', '/repo/packages/app', 8],
    ],
  );
});

test('reanchorHistoricalCwd refuses to move a worktree used by a live session', () => {
  const historical = summary('historical', { cwd: '/repo/.worktrees/feature' });
  const { history, published, registry } = createHarness({ ordinary: [historical] });
  registry.register(live(summary('live', { cwd: '/repo/.worktrees/feature/subdir' })));
  history.persisted.length = 0;

  assert.throws(
    () => registry.reanchorHistoricalCwd('/repo/.worktrees/feature', '/repo'),
    /live session is still using/i,
  );
  assert.deepEqual(history.persisted, []);
  assert.deepEqual(published, []);
  assert.equal(registry.resolveSummary('historical')?.cwd, '/repo/.worktrees/feature');
});

test('replaceProvider retains the alias chain and supports live and historical sessions', () => {
  let timestamp = 10;
  const retiredProviders: string[] = [];
  const historical = summary('historical-app', {
    providerSessionId: 'historical-provider',
    compactedFromProviderSessionIds: ['historical-provider-old'],
  });
  const { history, published, registry } = createHarness({
    ordinary: [historical],
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
  history.trace.length = 0;

  const unchanged = registry.replaceProvider('live-app', 'live-provider');

  assert.equal(unchanged, session.summary);
  assert.deepEqual(history.trace, []);
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
  assert.deepEqual(historicalUpdated?.compactedFromProviderSessionIds, [
    'historical-provider-old',
    'historical-provider',
  ]);
  assert.equal(historicalUpdated?.updatedAt, 1);
  assert.equal(registry.getLive('historical-provider-next'), undefined);
  assert.equal(registry.resolveSummary('historical-provider-next')?.appSessionId, 'historical-app');
  assert.deepEqual(
    retiredProviders,
    ['live-provider'],
    'historical swaps do not retire live files',
  );
  assert.deepEqual(history.trace, ['persist', 'publish', 'persist', 'publish']);
  assert.equal(published.length, 2);
});

test('failed provider replacement preserves the live summary and aliases', () => {
  const { history, published, registry } = createHarness({ now: () => 42 });
  const session = live(
    summary('stable-app', {
      providerSessionId: 'provider-current',
      compactedFromProviderSessionIds: ['provider-old'],
    }),
  );
  registry.register(session);
  history.nextSyncError = new Error('persist failed');

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

test('historical provider replacement is applied before hidden-provider filtering', () => {
  const mission = summary('historical-mission', {
    providerSessionId: 'mission-provider-old',
    sessionPurpose: 'mission-control',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'agi',
      autonomy: 'low',
    }),
  });
  const { history, registry } = createHarness({ missionControl: [mission] });

  registry.replaceProvider('mission-provider-old', 'mission-provider-current');
  history.hiddenProviderIds.add('mission-provider-old');

  const listed = registry.listSummaries().sessions;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.appSessionId, 'historical-mission');
  assert.equal(listed[0] && 'providerSessionId' in listed[0], false);
  assert.equal(
    listed[0]?.sessionWebUrl,
    'https://app.factory.ai/sessions/mission-provider-current',
  );
});

test('resolve and list project copies after ordinary, Mission Control, and live merging', () => {
  const ordinary = [
    summary('ordinary-only', { title: 'ordinary', updatedAt: 10 }),
    summary('mission-wins', { title: 'ordinary shadowed', updatedAt: 20 }),
    summary('live-wins', {
      providerSessionId: 'live-provider-old',
      title: 'ordinary live shadow',
      updatedAt: 30,
    }),
    summary('hidden-row', { providerSessionId: 'hidden-provider', updatedAt: 40 }),
  ];
  const missionControl = [
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
      providerSessionId: 'mission-live-provider',
      sessionPurpose: 'mission-control',
      title: 'mission live shadow',
      updatedAt: 60,
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    }),
  ];
  const { history, published, registry } = createHarness({
    ordinary,
    missionControl,
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
  history.hiddenProviderIds.add('hidden-provider');
  const liveSession = live(
    summary('live-wins', {
      providerSessionId: 'live-provider',
      compactedFromProviderSessionIds: ['live-provider-old'],
      title: 'live',
      updatedAt: 70,
    }),
  );
  registry.register(liveSession);
  history.clearPatches();

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
  assert.equal(history.persisted.at(-1)?.configuration.providerSelection.modelId, 'model-default');
  assert.equal(history.persisted.at(-1)?.title, 'canonical update');
  assert.equal(published.at(-1)?.configuration.providerSelection.modelId, 'projected-model');
  assert.equal(published.at(-1)?.title, 'projected: canonical update');
  assert.equal(registry.resolveSummary('live-wins')?.title, 'projected: canonical update');
});

test('projected and caller-owned feature state cannot mutate canonical summaries', () => {
  const sourceFeature = feature('feature-a');
  const { registry } = createHarness({
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

test('summary patches copy caller-owned feature state', () => {
  const { registry } = createHarness();
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

test('workspace scoping applies after canonical source precedence', () => {
  const { registry } = createHarness({
    ordinary: [summary('shared', { title: 'ordinary', updatedAt: 100 })],
    missionControl: [
      summary('shared', {
        title: 'mission control',
        sessionPurpose: 'mission-control',
        updatedAt: 50,
      }),
    ],
  });

  assert.deepEqual(
    registry
      .listSummaries({ workspaceCwds: ['/workspace'] })
      .sessions.map((item) => [item.appSessionId, item.title]),
    [['shared', 'mission control']],
  );
});

test('a persisted app-session row keeps an old session listed past the pre-existing bound', () => {
  const preexisting = Array.from({ length: 8 }, (_, index) =>
    summary(`preexisting-${String(index)}`, { updatedAt: 100 + index }),
  );
  const { history, registry } = createHarness({
    ordinary: [summary('ours', { updatedAt: 1 }), ...preexisting],
  });

  const bounded = registry.listSummaries({ workspaceCwds: ['/workspace'] });
  assert.ok(!bounded.sessions.some((item) => item.appSessionId === 'ours'));
  assert.deepEqual(bounded.earlierSessionsByCwd, { '/workspace': 4 });

  history.syncSummaries([summary('ours', { updatedAt: 1 })]);
  const owned = registry.listSummaries({ workspaceCwds: ['/workspace'] });
  assert.ok(owned.sessions.some((item) => item.appSessionId === 'ours'));
  assert.deepEqual(owned.earlierSessionsByCwd, { '/workspace': 3 });

  const revealed = registry.listSummaries({
    workspaceCwds: ['/workspace'],
    revealEarlierCwds: ['/workspace'],
  });
  assert.equal(revealed.sessions.length, 9);
  assert.deepEqual(revealed.earlierSessionsByCwd, {});
});

test('snapshot permits sequential unregister without skipping sessions', () => {
  const { registry } = createHarness();
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

test('listSummaries reads patches and hidden ids through a single history call', () => {
  const { history, registry } = createHarness({ ordinary: [summary('ordinary')] });

  registry.listSummaries();

  assert.equal(history.summaryReadCount, 1);
});

test('published summaries include a Droid web URL and omit native ids', () => {
  const { published, registry } = createHarness();
  registry.register(live(summary('app-droid', { providerSessionId: 'native-1' })));
  registry.updateSummary('app-droid', { title: 'Named' });
  const wire = published.at(-1);
  assert.equal(wire?.sessionWebUrl, 'https://app.factory.ai/sessions/native-1');
  assert.equal(wire && 'providerSessionId' in wire, false);
  assert.equal(JSON.stringify(wire).includes('"native-1"'), false);
});

test('published summaries omit sessionWebUrl for non-Droid providers', () => {
  const { published, registry } = createHarness();
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
  assert.equal(wire && 'providerSessionId' in wire, false);
  assert.equal(JSON.stringify(wire).includes('native-1'), false);
});

test('two live instances may share native id native-1 without colliding', () => {
  const { registry } = createHarness();
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

test('registry dual-writes summary updates through SessionStore when a row exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-registry-store-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  try {
    store.createProvisional({
      appSessionId: 'app-store',
      clientRef: 'ref-store',
      summary: summary('app-store'),
    });
    const { history } = createHarness();
    const withStore = new SessionRegistry<TestLiveSession>({
      history,
      loadOrdinarySessions: () => [],
      loadMissionControlSessions: () => [],
      projectSummary: (value) => copySummary(value),
      onSummaryUpdated: () => undefined,
      now: () => 50,
      sessionStore: store,
    });
    withStore.register(live(summary('app-store', { providerSessionId: 'native-store' })));
    withStore.updateSummary('app-store', { title: 'Stored title' });
    assert.equal(store.get('app-store')?.summary.title, 'Stored title');
    withStore.replaceProvider('app-store', 'native-next');
    assert.equal(store.get('app-store')?.binding.providerSessionId, 'native-next');
    assert.equal(store.get('app-store')?.binding.runtimeGeneration, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

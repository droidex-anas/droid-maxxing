import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoricalSession } from './history.js';
import type { SessionSummary } from './protocol.js';
import { SessionRegistry, type RegisteredSession } from './SessionRegistry.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

interface LiveSession extends RegisteredSession {
  marker: string;
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

function historical(value: SessionSummary): HistoricalSession {
  return { summary: value, progress: [] };
}

test('historical summaries and provider aliases reload only when the history revision changes', () => {
  let revision = 1;
  let loads = 0;
  let current = summary('app', 'provider-current', {
    compactedFromProviderSessionIds: ['provider-old'],
  });
  const history = {
    get revision() {
      return revision;
    },
    syncSummaries: () => undefined,
    summaryPatchesAndHidden: () => ({
      patches: new Map<string, Partial<SessionSummary>>(),
      hiddenProviderSessionIds: new Set<string>(),
    }),
  };
  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: () => {
      loads += 1;
      return [historical(current)];
    },
    loadMissionControlSessions: () => [],
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
  });

  assert.equal(registry.resolveSummary('provider-old')?.appSessionId, 'app');
  assert.equal(registry.resolveSummary('provider-current')?.appSessionId, 'app');
  assert.equal(loads, 1);

  current = summary('app', 'provider-next', {
    compactedFromProviderSessionIds: ['provider-old', 'provider-current'],
  });
  revision += 1;

  assert.equal(registry.resolveSummary('provider-next')?.providerSessionId, 'provider-next');
  assert.equal(registry.resolveSummary('provider-current')?.providerSessionId, 'provider-next');
  assert.equal(loads, 2);
});

test('reanchored historical cwd survives a read at a stable history revision', () => {
  const source = summary('app', 'provider', { cwd: '/repo/.worktrees/feature' });
  const history = {
    revision: 1,
    syncSummaries: () => undefined,
    summaryPatchesAndHidden: () => ({
      patches: new Map<string, Partial<SessionSummary>>(),
      hiddenProviderSessionIds: new Set<string>(),
    }),
  };
  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: () => [historical(source)],
    loadMissionControlSessions: () => [],
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
  });

  assert.deepEqual(
    registry.reanchorHistoricalCwd('/repo/.worktrees/feature', '/repo').map((item) => item.cwd),
    ['/repo'],
  );

  assert.equal(registry.resolveSummary('app')?.cwd, '/repo');
});

test('historical provider replacement preserves aliases at a stable history revision', () => {
  const source = summary('app', 'provider-current', {
    compactedFromProviderSessionIds: ['provider-old'],
  });
  const history = {
    revision: 1,
    syncSummaries: () => undefined,
    summaryPatchesAndHidden: () => ({
      patches: new Map<string, Partial<SessionSummary>>(),
      hiddenProviderSessionIds: new Set<string>(),
    }),
  };
  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: () => [historical(source)],
    loadMissionControlSessions: () => [],
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
  });

  registry.replaceProvider('provider-old', 'provider-next');

  assert.equal(registry.resolveSummary('provider-next')?.providerSessionId, 'provider-next');
  assert.equal(registry.resolveSummary('provider-current')?.providerSessionId, 'provider-next');
  assert.equal(registry.resolveSummary('provider-old')?.providerSessionId, 'provider-next');
});

test('Mission Control history is cached until the history revision changes', () => {
  let mission = summary('mission-one', 'mission-provider-one', {
    sessionPurpose: 'mission-control',
  });
  let missionLoads = 0;
  let revision = 1;
  const registry = new SessionRegistry<LiveSession>({
    history: {
      get revision() {
        return revision;
      },
      syncSummaries: () => undefined,
      summaryPatchesAndHidden: () => ({
        patches: new Map<string, Partial<SessionSummary>>(),
        hiddenProviderSessionIds: new Set<string>(),
      }),
    },
    loadOrdinarySessions: () => [],
    loadMissionControlSessions: () => {
      missionLoads += 1;
      return [historical(mission)];
    },
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
  });

  assert.equal(registry.listSummaries().sessions[0]?.appSessionId, 'mission-one');
  mission = summary('mission-two', 'mission-provider-two', {
    sessionPurpose: 'mission-control',
  });

  assert.equal(registry.listSummaries().sessions[0]?.appSessionId, 'mission-one');
  assert.equal(missionLoads, 1);
  revision += 1;
  assert.equal(registry.listSummaries().sessions[0]?.appSessionId, 'mission-two');
  assert.equal(missionLoads, 2);
});

test('a removed Mission row is not retained by a direct historical mutation', () => {
  let revision = 1;
  let missions = [
    summary('mission-one', 'mission-provider-current', {
      sessionPurpose: 'mission-control',
      compactedFromProviderSessionIds: ['mission-provider-old'],
    }),
  ];
  const registry = new SessionRegistry<LiveSession>({
    history: {
      get revision() {
        return revision;
      },
      syncSummaries: () => undefined,
      summaryPatchesAndHidden: () => ({
        patches: new Map<string, Partial<SessionSummary>>(),
        hiddenProviderSessionIds: new Set<string>(),
      }),
    },
    loadOrdinarySessions: () => [],
    loadMissionControlSessions: () => missions.map(historical),
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
  });

  registry.replaceProvider('mission-provider-old', 'mission-provider-next');
  missions = [];
  revision += 1;

  assert.deepEqual(registry.listSummaries().sessions, []);
});

test('unregister flushes persistence before exposing the session as closed', () => {
  const trace: string[] = [];
  const history = {
    revision: 0,
    syncSummaries: () => {
      trace.push('enqueue');
      return undefined;
    },
    flushSync: () => {
      trace.push('flush');
    },
    forgetSession: () => {
      trace.push('forget');
    },
    summaryPatchesAndHidden: () => ({
      patches: new Map<string, Partial<SessionSummary>>(),
      hiddenProviderSessionIds: new Set<string>(),
    }),
  };
  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: () => [],
    loadMissionControlSessions: () => [],
    projectSummary: (value) => ({ ...value, features: [...value.features] }),
    onSummaryUpdated: () => undefined,
    now: () => 2,
  });
  const live = { marker: 'live', summary: summary('app', 'provider') };
  registry.register(live);

  assert.equal(registry.unregister('provider'), live);
  assert.deepEqual(trace, ['enqueue', 'flush', 'forget']);
  assert.equal(registry.getLive('app'), undefined);
});

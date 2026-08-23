import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoricalSession } from './history.js';
import type { SessionSummary } from './protocol.js';
import { SessionRegistry, type RegisteredSession } from './SessionRegistry.js';

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
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/repo',
    autonomy: 'low',
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

test('unregister flushes persistence before exposing the session as closed', () => {
  const trace: string[] = [];
  const history = {
    revision: 0,
    syncSummaries: () => trace.push('enqueue'),
    flushSync: () => trace.push('flush'),
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
  assert.deepEqual(trace, ['enqueue', 'flush']);
  assert.equal(registry.getLive('app'), undefined);
});

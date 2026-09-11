import assert from 'node:assert/strict';
import test from 'node:test';

import { serverWireMessage } from './bridgeWireValidation';

function batch(event: unknown): unknown {
  return {
    type: 'events.batch',
    generation: 'generation-1',
    firstSeq: 1,
    lastSeq: 1,
    events: [{ seq: 1, event }],
  };
}

test('rejects approval requests with unknown permission kinds', () => {
  assert.equal(
    serverWireMessage(
      batch({
        type: 'approval.requested',
        request: {
          appSessionId: 'app-1',
          requestId: 'permission-1',
          kind: 'unknown-permission',
          title: 'Approve action',
          detail: 'Run the requested action.',
          raw: {},
        },
      }),
    ),
    null,
  );
});

test('rejects search results that omit the indexing completeness flag', () => {
  assert.equal(
    serverWireMessage(
      batch({
        type: 'sessions.searchResults',
        requestId: 'req-1',
        results: [],
      }),
    ),
    null,
  );
  assert.ok(
    serverWireMessage(
      batch({
        type: 'sessions.searchResults',
        requestId: 'req-1',
        results: [],
        indexingIncomplete: false,
      }),
    ),
  );
});

test('rejects malformed features in session summaries and mission updates', () => {
  const malformedFeature = { status: 'pending' };
  const session = {
    appSessionId: 'app-1',
    sessionPurpose: 'mission-control',
    interactionMode: 'agi',
    role: 'primary',
    title: 'Mission',
    goal: 'Ship safely',
    cwd: '/repo',
    autonomy: 'high',
    phase: 'running',
    features: [malformedFeature],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  assert.equal(serverWireMessage(batch({ type: 'session.updated', session })), null);
  assert.equal(
    serverWireMessage(
      batch({ type: 'mission.features', appSessionId: 'app-1', features: [malformedFeature] }),
    ),
    null,
  );
});

test('validates complete automation snapshot records', () => {
  const draft = {
    title: 'Morning summary',
    prompt: 'Summarize the repository.',
    workspaceCwd: '/repo',
    executionMode: 'worktree',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00' },
    timezone: 'UTC',
    modelId: 'model-a',
    reasoningEffort: 'high',
    autonomy: 'low',
  };
  const automation = {
    id: 'automation-1',
    ...draft,
    nextRunAt: 2,
    lastRunAt: 1,
    lastRunStatus: 'completed',
    lastRunError: null,
    lastRunDurationMs: 100,
    lastAppSessionId: 'session-1',
    completedAt: null,
    createdAt: 1,
    updatedAt: 2,
  };
  const run = {
    id: 'run-1',
    automationId: automation.id,
    automation: {
      id: automation.id,
      title: automation.title,
      prompt: automation.prompt,
      workspaceCwd: automation.workspaceCwd,
      executionMode: automation.executionMode,
      timezone: automation.timezone,
      modelId: automation.modelId,
      reasoningEffort: automation.reasoningEffort,
      autonomy: automation.autonomy,
    },
    scheduledAt: 1,
    requestedAt: 1,
    trigger: 'manual',
    status: 'completed',
    startedAt: 1,
    finishedAt: 2,
    clientRef: 'automation:run-1',
    appSessionId: 'session-1',
    resolvedCwd: '/repo/.worktrees/run-1',
    error: null,
    effectiveModelId: 'model-a',
    effectiveReasoningEffort: 'high',
    selectionVerified: true,
  };
  const proposal = {
    id: 'proposal-1',
    sourceAppSessionId: 'source-1',
    draft,
    status: 'confirmed',
    missingFields: [],
    automationId: automation.id,
    createdAt: 1,
    updatedAt: 2,
    confirmedAt: 2,
  };
  const snapshot = {
    automations: [automation],
    runs: [run],
    proposals: [proposal],
    sessionOrigins: {
      'session-1': {
        automationId: automation.id,
        automationTitle: automation.title,
        runId: run.id,
        trigger: 'manual',
      },
    },
    queuedRunCount: 0,
    activeRunCount: 0,
    scheduler: { ready: true, nextWakeAt: null, activeRunId: null },
  };
  assert.ok(serverWireMessage(batch({ type: 'automations.snapshot', snapshot })));

  const malformed = [
    { ...snapshot, automations: [{ id: automation.id }] },
    { ...snapshot, runs: [{ id: run.id }] },
    { ...snapshot, proposals: [{ id: proposal.id }] },
    {
      ...snapshot,
      automations: [{ ...automation, schedule: { kind: 'hourly', minute: 60 } }],
    },
    {
      ...snapshot,
      runs: [{ ...run, automation: { ...run.automation, reasoningEffort: 'turbo' } }],
    },
    {
      ...snapshot,
      proposals: [{ ...proposal, draft: { ...draft, executionMode: 'remote' } }],
    },
    {
      ...snapshot,
      automations: [{ ...automation, timezone: 'Not/A_Timezone' }],
    },
    {
      ...snapshot,
      automations: [{ ...automation, schedule: { kind: 'daily', time: '9:00' } }],
    },
    {
      ...snapshot,
      automations: [{ ...automation, schedule: { kind: 'cron', expression: '61 * * * *' } }],
    },
    {
      ...snapshot,
      sessionOrigins: { 'session-1': { automationId: automation.id, runId: run.id } },
    },
    { ...snapshot, scheduler: { ...snapshot.scheduler, nextWakeAt: Number.NaN } },
  ];
  for (const candidate of malformed) {
    assert.equal(
      serverWireMessage(batch({ type: 'automations.snapshot', snapshot: candidate })),
      null,
    );
  }
});

test('validates automation command results by outcome', () => {
  assert.ok(
    serverWireMessage(
      batch({
        type: 'automations.result',
        requestId: 'request-1',
        ok: true,
        runId: 'run-1',
      }),
    ),
  );
  assert.ok(
    serverWireMessage(
      batch({
        type: 'automations.result',
        requestId: 'request-2',
        ok: false,
        error: 'Automation not found.',
      }),
    ),
  );
  assert.equal(
    serverWireMessage(
      batch({
        type: 'automations.result',
        requestId: 'request-3',
        ok: false,
      }),
    ),
    null,
  );
  assert.equal(
    serverWireMessage(
      batch({
        type: 'automations.result',
        requestId: 'request-4',
        ok: true,
        runId: 4,
      }),
    ),
    null,
  );
});

test('validates session.processes events and rejects malformed process entries', () => {
  const process = {
    pid: 123,
    name: 'ripgrep',
    command: 'rg foo',
    startedAt: 1,
    ports: [],
  };
  assert.ok(
    serverWireMessage(
      batch({ type: 'session.processes', appSessionId: 'app-1', processes: [process] }),
    ),
  );
  assert.equal(
    serverWireMessage(
      batch({
        type: 'session.processes',
        appSessionId: 'app-1',
        processes: [{ ...process, pid: 'not-a-number' }],
      }),
    ),
    null,
  );
  assert.equal(
    serverWireMessage(
      batch({
        type: 'session.processes',
        appSessionId: 'app-1',
        processes: [{ ...process, ports: ['8080', null] }],
      }),
    ),
    null,
  );
});

test('rejects object payloads that are actually arrays', () => {
  assert.equal(serverWireMessage(batch({ type: 'settings.defaults', defaults: [] })), null);
  assert.ok(serverWireMessage(batch({ type: 'settings.defaults', defaults: {} })));
  assert.equal(
    serverWireMessage(
      batch({
        type: 'sessions.searchResults',
        requestId: 'req-1',
        results: [[]],
        indexingIncomplete: false,
      }),
    ),
    null,
  );
});

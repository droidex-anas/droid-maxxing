import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LiveRuntimeJournal, liveRuntimeJournalPath } from './liveRuntimeJournal.js';
import { SessionAdoption } from './sessionAdoption.js';
import type { SessionSummary } from './protocol.js';

function summary(appSessionId: string, phase: SessionSummary['phase'] = 'running'): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '',
    autonomy: 'low',
    phase,
    streaming: phase === 'running',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('failed provider adoption marks the session interrupted instead of running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-'));
  try {
    const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
    journal.write({
      sessions: [
        {
          appSessionId: 'app-1',
          providerSessionId: 'provider-app-1',
          phase: 'running',
          streaming: true,
        },
      ],
      children: [],
    });
    const historical = summary('app-1');
    const persisted: SessionSummary[] = [];
    const statuses: string[] = [];
    const adoption = new SessionAdoption({
      journal,
      registry: {
        liveSessionsSnapshot: () => [],
        getCanonicalSummary: () => historical,
        getLive: () => undefined,
      },
      lifecycle: {
        resume: async () => false,
      },
      liveChildren: () => [],
      persistSummaries: (sessions) => {
        persisted.push(...sessions);
      },
      emitStatus: (_appSessionId, text) => {
        statuses.push(text);
      },
    });

    const result = await adoption.adopt();
    assert.equal(result.interrupted.length, 1);
    assert.equal(persisted[0]?.phase, 'paused');
    assert.equal(persisted[0]?.streaming, false);
    assert.match(persisted[0]?.interruptReason ?? '', /could not reconnect/);
    assert.equal(statuses.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a resumed in-flight session is paused with an interrupt reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-resume-'));
  try {
    const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
    journal.write({
      sessions: [
        {
          appSessionId: 'app-2',
          providerSessionId: 'provider-app-2',
          phase: 'running',
          streaming: true,
        },
      ],
      children: [],
    });
    const live = { summary: summary('app-2') };
    const persisted: SessionSummary[] = [];
    const adoption = new SessionAdoption({
      journal,
      registry: {
        liveSessionsSnapshot: () => [live],
        getCanonicalSummary: () => live.summary,
        getLive: () => live,
      },
      lifecycle: {
        resume: async () => true,
      },
      liveChildren: () => [],
      persistSummaries: (sessions) => {
        persisted.push(...sessions);
        live.summary = sessions[0] ?? live.summary;
      },
      emitStatus: () => undefined,
    });

    const result = await adoption.adopt();
    assert.equal(result.interrupted[0]?.reason.includes('did not continue'), true);
    assert.equal(live.summary.phase, 'paused');
    assert.equal(live.summary.streaming, false);
    assert.equal(typeof live.summary.interruptReason, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('running children are marked interrupted and written out of the live journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-child-'));
  try {
    const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
    journal.write({
      sessions: [],
      children: [
        {
          parentAppSessionId: 'app-3',
          childSessionId: 'child-1',
          status: 'running',
        },
      ],
    });
    const liveChildren = [
      {
        parentAppSessionId: 'app-3',
        childSessionId: 'child-1',
        status: 'running' as const,
      },
    ];
    const adoption = new SessionAdoption({
      journal,
      registry: {
        liveSessionsSnapshot: () => [],
        getCanonicalSummary: () => undefined,
        getLive: () => undefined,
      },
      lifecycle: {
        resume: async () => false,
      },
      liveChildren: () => liveChildren,
      persistSummaries: () => undefined,
      emitStatus: () => undefined,
    });

    const result = await adoption.adopt();
    assert.equal(result.interrupted[0]?.childSessionId, 'child-1');
    assert.match(result.interrupted[0]?.reason ?? '', /child agent did not continue/);

    liveChildren.length = 0;
    adoption.persistLiveSet();
    assert.deepEqual(journal.read().children, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LiveRuntimeJournal,
  liveRuntimeJournalPath,
  type LiveChildIdentity,
  type LiveSessionIdentity,
} from './liveRuntimeJournal.js';
import { SessionAdoption } from './sessionAdoption.js';
import { SESSION_RUNTIME_IDLE_RETIREMENT_MS } from './sessionRuntimeRetirement.js';
import type { SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

const NOW = 4_000_000_000;

function summary(appSessionId: string, phase: SessionSummary['phase'] = 'running'): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
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
          lastActiveAt: 1,
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
      sessionRuntimeIdleMs: SESSION_RUNTIME_IDLE_RETIREMENT_MS,
      now: () => NOW,
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
          lastActiveAt: 1,
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
      sessionRuntimeIdleMs: SESSION_RUNTIME_IDLE_RETIREMENT_MS,
      now: () => NOW,
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
      sessionRuntimeIdleMs: SESSION_RUNTIME_IDLE_RETIREMENT_MS,
      now: () => NOW,
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

// Adoption spawns a provider process per journalled session. These cover the
// sessions it must not spawn one for, because the first retirement sweep would
// release it moments later, and the ones it must still spawn one for however
// long they have been idle.
interface BootCase {
  identity?: Partial<LiveSessionIdentity>;
  children?: LiveChildIdentity[];
}

function bootAdoption(dir: string, options: BootCase = {}) {
  const identity: LiveSessionIdentity = {
    appSessionId: 'app-boot',
    providerSessionId: 'provider-app-boot',
    phase: 'completed',
    streaming: false,
    lastActiveAt: NOW - SESSION_RUNTIME_IDLE_RETIREMENT_MS - 1,
    ...options.identity,
  };
  const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
  journal.write({ sessions: [identity], children: options.children ?? [] });
  const resumed: string[] = [];
  const adoption = new SessionAdoption({
    journal,
    registry: {
      liveSessionsSnapshot: () => [],
      getCanonicalSummary: () => summary(identity.appSessionId, 'completed'),
      getLive: () => undefined,
    },
    lifecycle: {
      resume: async (appSessionId: string) => {
        resumed.push(appSessionId);
        return true;
      },
    },
    liveChildren: () => [],
    persistSummaries: () => undefined,
    emitStatus: () => undefined,
    sessionRuntimeIdleMs: SESSION_RUNTIME_IDLE_RETIREMENT_MS,
    now: () => NOW,
  });
  return { adoption, journal, resumed };
}

async function bootResumes(name: string, options: BootCase): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    const { adoption, resumed } = bootAdoption(dir, options);
    await adoption.adopt();
    return resumed.length > 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a settled session idle past the budget is not given a provider process at boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-idle-'));
  try {
    const { adoption, journal, resumed } = bootAdoption(dir);
    const result = await adoption.adopt();

    assert.deepEqual(resumed, []);
    // Nothing was interrupted, so the user is told nothing: the session is a
    // reopenable entry with its transcript, exactly as a retired one is.
    assert.deepEqual(result.interrupted, []);
    assert.deepEqual(journal.read().sessions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a settled session inside the budget still gets its runtime back', async () => {
  assert.equal(
    await bootResumes('adoption-fresh', {
      identity: { lastActiveAt: NOW - SESSION_RUNTIME_IDLE_RETIREMENT_MS + 60_000 },
    }),
    true,
  );
});

test('a session interrupted mid-turn is resurrected however long it has been idle', async () => {
  assert.equal(
    await bootResumes('adoption-midturn', {
      identity: { phase: 'running', streaming: true },
    }),
    true,
  );
});

test('a session awaiting plan approval is resurrected however long it has been idle', async () => {
  assert.equal(
    await bootResumes('adoption-plan', {
      identity: { phase: 'awaiting_plan_approval' },
    }),
    true,
  );
});

test('a session whose children were still running is resurrected', async () => {
  assert.equal(
    await bootResumes('adoption-children', {
      children: [{ parentAppSessionId: 'app-boot', childSessionId: 'child-1', status: 'running' }],
    }),
    true,
  );
});

test('the journal carries when each live session was last active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-journal-'));
  try {
    const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
    const live = { summary: { ...summary('app-journal', 'completed'), updatedAt: 12_345 } };
    const adoption = new SessionAdoption({
      journal,
      registry: {
        liveSessionsSnapshot: () => [live],
        getCanonicalSummary: () => live.summary,
        getLive: () => live,
      },
      lifecycle: { resume: async () => true },
      liveChildren: () => [],
      persistSummaries: () => undefined,
      emitStatus: () => undefined,
      sessionRuntimeIdleMs: SESSION_RUNTIME_IDLE_RETIREMENT_MS,
      now: () => NOW,
    });

    adoption.persistLiveSet();
    assert.equal(journal.read().sessions[0]?.lastActiveAt, 12_345);

    // A journal entry without it cannot be judged against the budget, so it is
    // not a journal entry. Only DROIDEX writes this file.
    writeFileSync(
      liveRuntimeJournalPath(dir),
      JSON.stringify({
        sessions: [
          {
            appSessionId: 'app-journal',
            providerSessionId: 'provider-app-journal',
            phase: 'completed',
            streaming: false,
          },
        ],
        children: [],
      }),
    );
    assert.deepEqual(journal.read().sessions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

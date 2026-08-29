import assert from 'node:assert/strict';
import test from 'node:test';

import type { LiveSession } from './SessionLifecycle.js';
import type { SessionSummary } from './protocol.js';
import {
  nextSessionRetirementAt,
  retirableSessions,
  SessionRuntimeRetirement,
  type SessionRetirementFacts,
  type SessionRuntimeRetirementDependencies,
} from './sessionRuntimeRetirement.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { StubProviderSession } from './testing/stubProviderSession.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

const IDLE_MS = 1_800_000;

function facts(
  appSessionId: string,
  idleSince: number,
  patch: Partial<SessionRetirementFacts> = {},
): SessionRetirementFacts {
  return {
    appSessionId,
    idleSince,
    phase: 'paused',
    streaming: false,
    compacting: false,
    queuedSends: 0,
    interrupting: false,
    closing: false,
    focused: false,
    hasUnsettledChildren: false,
    hasOpenBrowser: false,
    hasPendingSettings: false,
    ...patch,
  };
}

test('a settled background session is retirable only once it passes the idle budget', () => {
  const idle = [facts('a', 1_000)];

  assert.deepEqual(retirableSessions(idle, 1_000 + IDLE_MS - 1, IDLE_MS), []);
  assert.deepEqual(retirableSessions(idle, 1_000 + IDLE_MS, IDLE_MS), ['a']);
});

test('a session the user is looking at is never retirable, however long it sits', () => {
  const forever = 1_000 + IDLE_MS * 100;

  assert.deepEqual(retirableSessions([facts('a', 1_000, { focused: true })], forever, IDLE_MS), []);
});

test('a session with work, unsaved intent, or a resource in use is never retirable', () => {
  const forever = 1_000 + IDLE_MS * 100;
  const blocked: [string, Partial<SessionRetirementFacts>][] = [
    ['mid-turn', { streaming: true }],
    ['mid-mission-turn', { phase: 'orchestrator_turn', streaming: true }],
    ['still-initializing', { phase: 'initializing' }],
    ['awaiting-plan-approval', { phase: 'awaiting_plan_approval' }],
    ['awaiting-run-start', { phase: 'awaiting_run_start' }],
    ['compacting', { compacting: true }],
    ['queued-prompt', { queuedSends: 1 }],
    ['interrupting', { interrupting: true }],
    ['already-closing', { closing: true }],
    ['children-working', { hasUnsettledChildren: true }],
    ['browser-open', { hasOpenBrowser: true }],
    ['unapplied-model-choice', { hasPendingSettings: true }],
  ];

  for (const [label, patch] of blocked) {
    assert.deepEqual(
      retirableSessions([facts(label, 1_000, patch)], forever, IDLE_MS),
      [],
      `${label} must never be retired`,
    );
  }
});

test('the next deadline follows the session that went idle first', () => {
  const idle = [facts('older', 1_000), facts('newer', 4_000)];

  assert.equal(nextSessionRetirementAt(idle, IDLE_MS), 1_000 + IDLE_MS);
  assert.equal(
    nextSessionRetirementAt([facts('busy', 1_000, { streaming: true })], IDLE_MS),
    undefined,
  );
  assert.equal(nextSessionRetirementAt([], IDLE_MS), undefined);
});

interface OwnerHarness {
  owner: SessionRuntimeRetirement;
  retired: string[];
  statuses: { appSessionId: string; text: string }[];
  errors: { appSessionId: string; message: string }[];
  live: Map<string, LiveSession>;
  focus: { current: string | null };
  clock: { now: number };
  add(appSessionId: string, updatedAt: number, patch?: Partial<LiveSession>): LiveSession;
}

function liveSession(appSessionId: string, updatedAt: number): LiveSession {
  const summary = {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'off',
    }),
    phase: 'paused',
    streaming: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 0,
    updatedAt,
  } satisfies SessionSummary;
  return {
    summary,
    binding: {
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      providerSessionId: appSessionId,
      previousProviderSessionIds: [],
      runtimeGeneration: 1,
    },
    session: new FakeFactorySession(appSessionId, {}, []),
    provider: new StubProviderSession(appSessionId),
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    mcpServers: [],
    mcpConfigs: [],
  };
}

function ownerHarness(overrides: Partial<SessionRuntimeRetirementDependencies> = {}): OwnerHarness {
  const retired: string[] = [];
  const statuses: { appSessionId: string; text: string }[] = [];
  const errors: { appSessionId: string; message: string }[] = [];
  const live = new Map<string, LiveSession>();
  const focus = { current: null as string | null };
  const clock = { now: 10_000 };
  const owner = new SessionRuntimeRetirement({
    liveSessions: () => [...live.values()],
    focusedAppSessionId: () => focus.current,
    hasUnsettledChildren: () => false,
    hasOpenBrowser: () => false,
    hasPendingSettings: () => false,
    retire: (appSessionId) => {
      retired.push(appSessionId);
      live.delete(appSessionId);
      return Promise.resolve();
    },
    emitStatus: (appSessionId, text) => statuses.push({ appSessionId, text }),
    emitError: (appSessionId, message) => errors.push({ appSessionId, message }),
    idleMs: IDLE_MS,
    now: () => clock.now,
    ...overrides,
  });
  return {
    owner,
    retired,
    statuses,
    errors,
    live,
    focus,
    clock,
    add(appSessionId, updatedAt, patch = {}) {
      const session = Object.assign(liveSession(appSessionId, updatedAt), patch);
      live.set(appSessionId, session);
      return session;
    },
  };
}

test('nothing is retirable until the renderer has reported what is on screen', async () => {
  const h = ownerHarness();
  h.add('background', 0);
  h.clock.now = IDLE_MS * 10;

  await h.owner.sweep();
  assert.deepEqual(h.retired, []);

  h.focus.current = 'other';
  h.owner.noteFocus(null);
  await h.owner.sweep();
  assert.deepEqual(h.retired, ['background']);
  assert.deepEqual(
    h.statuses.map(({ appSessionId }) => appSessionId),
    ['background'],
  );
});

test('a session stays warm for a full budget after the user switches away from it', async () => {
  const h = ownerHarness();
  h.add('read-for-a-while', 0);
  h.focus.current = 'read-for-a-while';
  h.owner.noteFocus(null);
  h.clock.now = IDLE_MS * 10;

  // Switching away starts the clock: an old updatedAt must not make a session
  // the user just left immediately retirable.
  h.focus.current = 'elsewhere';
  h.owner.noteFocus('read-for-a-while');
  await h.owner.sweep();
  assert.deepEqual(h.retired, []);

  h.clock.now += IDLE_MS;
  await h.owner.sweep();
  assert.deepEqual(h.retired, ['read-for-a-while']);
});

test('a prompt that arrives during an earlier release saves the session behind it', async () => {
  let releaseSecond = (): void => undefined;
  const retired: string[] = [];
  const h = ownerHarness({
    retire: (appSessionId) => {
      retired.push(appSessionId);
      if (appSessionId !== 'first') return Promise.resolve();
      // Standing in for the awaited close of the session ahead in the queue.
      return new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    },
  });
  h.add('first', 0);
  const second = h.add('second', 0);
  h.focus.current = 'elsewhere';
  h.owner.noteFocus(null);
  h.clock.now = IDLE_MS * 10;

  const sweeping = h.owner.sweep();
  second.streaming = true;
  releaseSecond();
  await sweeping;

  assert.deepEqual(retired, ['first']);
  assert.deepEqual(
    h.statuses.map(({ appSessionId }) => appSessionId),
    ['first'],
    'a session that started a turn must not be told its runtime went away',
  );
});

test('a closed session stops carrying the moment the user last looked at it', async () => {
  const h = ownerHarness();
  h.add('reopened', 0);
  h.focus.current = 'reopened';
  h.owner.noteFocus(null);
  h.clock.now = IDLE_MS * 10;

  h.focus.current = 'elsewhere';
  h.owner.noteFocus('reopened');
  h.live.delete('reopened');
  h.owner.arm();

  // Resumed with nothing newer than its last turn: the pre-close switch-away
  // must not be what keeps it warm.
  h.add('reopened', 0);
  await h.owner.sweep();
  assert.deepEqual(h.retired, ['reopened']);
});

test('a failed release is reported and does not stop the rest of the sweep', async () => {
  const h = ownerHarness({
    retire: (appSessionId) => {
      if (appSessionId === 'broken') return Promise.reject(new Error('flush failed'));
      return Promise.resolve();
    },
  });
  h.add('broken', 0);
  h.add('fine', 0);
  h.focus.current = 'elsewhere';
  h.owner.noteFocus(null);
  h.clock.now = IDLE_MS * 10;

  await h.owner.sweep();
  assert.deepEqual(h.errors, [
    {
      appSessionId: 'broken',
      message: "Could not release this session's idle runtime: flush failed",
    },
  ]);
  assert.equal(
    h.statuses.some(({ appSessionId }) => appSessionId === 'fine'),
    true,
  );
});

test('the timer is armed only while a session is actually retirable', () => {
  const scheduled: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  Reflect.set(globalThis, 'setTimeout', (_fn: () => void, ms: number) => {
    scheduled.push(ms);
    return { unref: () => undefined };
  });
  Reflect.set(globalThis, 'clearTimeout', () => undefined);
  try {
    const h = ownerHarness();
    const streaming = h.add('streaming', 0, { streaming: true });
    h.focus.current = null;
    h.owner.noteFocus(null);

    h.owner.arm();
    assert.equal(h.owner.armedFor(), undefined, 'a streaming session must not arm a wakeup');
    assert.deepEqual(scheduled, []);

    streaming.streaming = false;
    h.owner.arm();
    assert.equal(h.owner.armedFor(), IDLE_MS);
    assert.deepEqual(scheduled, [IDLE_MS - h.clock.now]);

    h.live.clear();
    h.owner.arm();
    assert.equal(h.owner.armedFor(), undefined);

    h.add('idle-again', 0);
    h.owner.arm();
    assert.equal(h.owner.armedFor(), IDLE_MS);
    h.owner.stop();
    assert.equal(h.owner.armedFor(), undefined);

    h.owner.arm();
    assert.equal(h.owner.armedFor(), undefined, 'a stopped owner never arms again');
  } finally {
    Reflect.set(globalThis, 'setTimeout', realSetTimeout);
    Reflect.set(globalThis, 'clearTimeout', realClearTimeout);
  }
});

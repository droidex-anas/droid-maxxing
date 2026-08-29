import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import { persistBindingUpdated } from './providerBinding.js';
import { encodeDroidResumeState } from './providers/droid/DroidModeMapping.js';
import {
  parseProviderRuntimeEvent,
  type ProviderRuntimeEvent,
} from './providers/providerEvents.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import type { SessionSummary } from './protocol.js';

function withStore(run: (store: SessionStore) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-binding-'));
  const path = join(dir, 'state', 'droidex.sqlite');
  const db = new DroidexDatabase(path);
  const store = new SessionStore(db);
  return Promise.resolve()
    .then(() => run(store))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function summary(appSessionId: string): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: 'goal',
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'intake',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function seed(store: SessionStore, appSessionId: string, nativeId = 'native-1') {
  store.createProvisional({
    appSessionId,
    clientRef: `ref-${appSessionId}`,
    summary: summary(appSessionId),
  });
  return store.bindInitialProviderRuntime(
    appSessionId,
    0,
    nativeId,
    encodeDroidResumeState(nativeId),
  );
}

function bindingEvent(
  appSessionId: string,
  overrides: Record<string, unknown> = {},
  bindingOverrides: Record<string, unknown> = {},
): Extract<ProviderRuntimeEvent, { type: 'binding.updated' }> {
  const event = parseProviderRuntimeEvent({
    eventId: 'bind-1',
    target: { kind: 'session', appSessionId },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 1,
    createdAt: 1,
    type: 'binding.updated',
    binding: {
      resumeState: encodeDroidResumeState('native-1'),
      ...bindingOverrides,
    },
    ...overrides,
  });
  if (event.type !== 'binding.updated') throw new Error('expected binding.updated');
  return event;
}

test('a resume-state-only update persists without changing the native id or generation', async () => {
  await withStore((store) => {
    const seeded = seed(store, 'app-1');
    const nextState = { schemaVersion: 1 as const, sessionId: 'native-1', cursor: 'opaque' };
    const next = persistBindingUpdated(
      store,
      bindingEvent('app-1', {}, { resumeState: nextState }),
      seeded.binding,
    );
    assert.ok(next);
    assert.deepEqual(next.resumeState, nextState);
    assert.equal(next.providerSessionId, 'native-1');
    assert.equal(next.runtimeGeneration, 1);
    assert.equal(store.get('app-1')?.binding.runtimeGeneration, 1);
  });
});

test('native-id plus resume-state replacement persists through compare-and-swap', async () => {
  await withStore((store) => {
    const seeded = seed(store, 'app-1');
    const resumeState = encodeDroidResumeState('native-2');
    const next = persistBindingUpdated(
      store,
      bindingEvent('app-1', {}, { providerSessionId: 'native-2', resumeState }),
      seeded.binding,
    );
    assert.ok(next);
    assert.equal(next.providerSessionId, 'native-2');
    assert.deepEqual(next.resumeState, resumeState);
    assert.equal(next.runtimeGeneration, 2);
    assert.deepEqual(next.previousProviderSessionIds, ['native-1']);
  });
});

test('a stale generation is rejected and publishes nothing', async () => {
  await withStore((store) => {
    const seeded = seed(store, 'app-1');
    const before = store.get('app-1')?.binding;
    const next = persistBindingUpdated(
      store,
      bindingEvent(
        'app-1',
        { runtimeGeneration: 9 },
        { resumeState: encodeDroidResumeState('native-9') },
      ),
      seeded.binding,
    );
    assert.equal(next, undefined);
    assert.deepEqual(store.get('app-1')?.binding, before);
  });
});

test('a wrong provider instance is rejected and publishes nothing', async () => {
  await withStore((store) => {
    const seeded = seed(store, 'app-1');
    const before = store.get('app-1')?.binding;
    const next = persistBindingUpdated(
      store,
      bindingEvent('app-1', { providerInstanceId: 'codex' }),
      seeded.binding,
    );
    assert.equal(next, undefined);
    assert.deepEqual(store.get('app-1')?.binding, before);
  });
});

test('a compare-and-swap failure publishes nothing dependent', async () => {
  await withStore((store) => {
    const seeded = seed(store, 'app-1');
    store.updateResumeState('app-1', 1, encodeDroidResumeState('already-written'));
    const failing: Pick<SessionStore, 'get' | 'updateResumeState' | 'replaceProviderRuntime'> = {
      get: (id) => store.get(id),
      updateResumeState: () => {
        throw new Error('cas failed');
      },
      replaceProviderRuntime: (id, generation, native, resume) =>
        store.replaceProviderRuntime(id, generation, native, resume),
    };
    const next = persistBindingUpdated(
      failing,
      bindingEvent('app-1', {}, { resumeState: encodeDroidResumeState('lost') }),
      seeded.binding,
    );
    assert.equal(next, undefined);
    assert.deepEqual(
      store.get('app-1')?.binding.resumeState,
      encodeDroidResumeState('already-written'),
    );
  });
});

test('two ordered binding updates apply in order', async () => {
  await withStore((store) => {
    let current = seed(store, 'app-1').binding;
    const first = encodeDroidResumeState('native-1');
    const firstWithCursor = { ...first, cursor: 'one' };
    const secondWithCursor = { ...first, cursor: 'two' };
    const afterFirst = persistBindingUpdated(
      store,
      bindingEvent('app-1', { eventId: 'bind-a' }, { resumeState: firstWithCursor }),
      current,
    );
    assert.ok(afterFirst);
    current = afterFirst;
    const afterSecond = persistBindingUpdated(
      store,
      bindingEvent('app-1', { eventId: 'bind-b' }, { resumeState: secondWithCursor }),
      current,
    );
    assert.ok(afterSecond);
    assert.deepEqual(afterSecond.resumeState, secondWithCursor);
    assert.deepEqual(store.get('app-1')?.binding.resumeState, secondWithCursor);
    assert.equal(store.get('app-1')?.binding.runtimeGeneration, 1);
  });
});

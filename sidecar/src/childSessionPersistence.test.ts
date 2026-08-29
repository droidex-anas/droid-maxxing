import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  childPersistenceFromStore,
  persistedChildFromStored,
} from './childCanonicalPersistence.js';
import type { PersistedChildSession } from './ChildSessionState.js';
import type { SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';

function withStore(run: (store: SessionStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-child-persist-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  try {
    run(new SessionStore(db));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function parentSummary(appSessionId: string): SessionSummary {
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

function createParent(store: SessionStore, appSessionId: string): void {
  store.createProvisional({
    appSessionId,
    clientRef: `ref-${appSessionId}`,
    summary: parentSummary(appSessionId),
  });
  store.bindInitialProviderRuntime(appSessionId, 0, `native-${appSessionId}`);
  store.markStarted(appSessionId);
}

function child(
  parentAppSessionId: string,
  childSessionId: string,
  overrides: Partial<PersistedChildSession> = {},
): PersistedChildSession {
  return {
    parentAppSessionId,
    childSessionId,
    providerSessionId: `provider-${parentAppSessionId}-${childSessionId}`,
    role: 'worker',
    label: 'Worker',
    prompt: `Prompt for ${childSessionId}`,
    status: 'running',
    modelId: 'claude-sonnet-4-5',
    reasoningEffort: 'high',
    spawnLink: { kind: 'tool-use', id: `tool-${childSessionId}` },
    transcriptAvailable: true,
    startedAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

test('child persistence preserves exact identity, settings, role, and hierarchy across reopen', () => {
  withStore((store) => {
    createParent(store, 'parent-a');
    createParent(store, 'parent-b');
    const persistence = childPersistenceFromStore(store);
    const binding = store.get('parent-a')!.binding;
    persistence.upsert(child('parent-a', 'child-a', { label: 'Same-role worker' }), binding);
    persistence.upsert(child('parent-a', 'child-b', { label: 'Same-role worker' }), binding);
    persistence.upsert(
      child('parent-b', 'child-a', {
        role: 'validator',
        label: 'Validator',
        modelId: 'claude-opus-4-1',
        reasoningEffort: 'max',
        spawnLink: { kind: 'spawn', id: 'spawn-validator' },
        transcriptAvailable: false,
        status: 'pending',
      }),
      store.get('parent-b')!.binding,
    );

    const parentA = persistence.list('parent-a');
    const parentBChild = persistence.get('parent-b', 'child-a');
    assert.deepEqual(
      parentA.map(({ childSessionId, role, label }) => ({ childSessionId, role, label })),
      [
        { childSessionId: 'child-a', role: 'worker', label: 'Same-role worker' },
        { childSessionId: 'child-b', role: 'worker', label: 'Same-role worker' },
      ],
    );
    assert.equal(parentBChild?.role, 'validator');
    assert.equal(parentBChild?.label, 'Validator');
    assert.equal(parentBChild?.modelId, 'claude-opus-4-1');
    assert.equal(parentBChild?.reasoningEffort, 'max');
    assert.deepEqual(parentBChild?.spawnLink, { kind: 'spawn', id: 'spawn-validator' });
    assert.equal(parentBChild?.transcriptAvailable, false);
    assert.equal(parentBChild?.status, 'pending');
    assert.equal(parentBChild?.childSessionId, 'child-a');
    assert.equal(store.list().some((row) => row.summary.appSessionId === 'child-a'), false);
  });
});

test('provider replacement updates runtime identity without changing logical child identity', () => {
  withStore((store) => {
    createParent(store, 'parent-rekey');
    const persistence = childPersistenceFromStore(store);
    const binding = store.get('parent-rekey')!.binding;
    const original = child('parent-rekey', 'stable-child', {
      providerSessionId: 'provider-old',
      status: 'paused',
    });
    persistence.upsert(original, binding);
    persistence.upsert(
      {
        ...original,
        providerSessionId: 'provider-new',
        previousProviderSessionIds: ['provider-old'],
        status: 'running',
        updatedAt: 300,
      },
      binding,
    );

    const restored = persistence.list('parent-rekey');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].childSessionId, 'stable-child');
    assert.equal(restored[0].providerSessionId, 'provider-new');
    assert.deepEqual(restored[0].previousProviderSessionIds, ['provider-old']);
    assert.equal(restored[0].status, 'running');
    assert.equal(persistedChildFromStored(store.getChild('parent-rekey', 'stable-child')!).childSessionId, 'stable-child');
  });
});

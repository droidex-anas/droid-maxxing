import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import { TranscriptStore } from './persistence/TranscriptStore.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import {
  listPageFromStore,
  requireStoredSession,
  UnknownAppSessionError,
} from './sessionCanonicalServing.js';
import type { SessionSummary } from './protocol.js';

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

test('public native ids never resolve as app ids and do not cross-route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-f8-serving-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  try {
    store.createProvisional({
      appSessionId: 'app-droid',
      clientRef: 'ref-droid',
      summary: summary('app-droid'),
    });
    store.createProvisional({
      appSessionId: 'app-codex',
      clientRef: 'ref-codex',
      summary: {
        ...summary('app-codex'),
        configuration: {
          ...summary('app-codex').configuration,
          providerSelection: {
            ...summary('app-codex').configuration.providerSelection,
            providerInstanceId: 'codex',
          },
        },
      },
    });
    store.bindInitialProviderRuntime('app-droid', 0, 'native-1');
    store.bindInitialProviderRuntime('app-codex', 0, 'native-1');
    assert.throws(() => requireStoredSession(store, 'native-1'), UnknownAppSessionError);
    assert.equal(requireStoredSession(store, 'app-droid').binding.providerSessionId, 'native-1');
    assert.equal(requireStoredSession(store, 'app-codex').binding.providerSessionId, 'native-1');
    const page = listPageFromStore(store, {}, (item) => item, new Map());
    assert.deepEqual(page.sessions.map((item) => item.appSessionId).sort(), [
      'app-codex',
      'app-droid',
    ]);
    assert.equal(
      page.sessions.every((item) => item.providerSessionId === undefined),
      true,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

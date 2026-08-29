import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { markFailedOpen, persistProvisionalIdentity } from './sessionCreateIdentity.js';
import type { SessionCreateCommand } from './sessionCreateIdentity.js';
import { initializingCreateSummary } from './sessionCreateIdentity.js';

function command(clientRef = 'shared-ref'): SessionCreateCommand {
  return {
    type: 'session.create',
    clientRef,
    title: 'Identity',
    goal: 'goal',
    cwd: '/workspace',
    sessionPurpose: 'chat',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
  };
}

test('markFailedOpen never fails a different session that shares a clientRef', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-create-identity-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  try {
    const create = command();
    const existing = initializingCreateSummary(create, 'app-existing', create.configuration, 1);
    persistProvisionalIdentity(
      { sessionStore: store, atomic: (work) => db.atomic(work) },
      create,
      existing,
      'turn-1',
    );
    markFailedOpen(
      { sessionStore: store, atomic: (work) => db.atomic(work) },
      create,
      { appSessionId: 'app-missing', turnId: 'turn-missing' },
      new Error('persist already exists'),
    );
    assert.equal(store.get('app-existing')?.lifecycleStatus, 'initializing');
    assert.equal(store.get('app-missing'), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionSummary } from '../protocol.js';
import type { ProviderError } from '../providers/providerErrors.js';
import { droidSessionConfiguration } from '../providers/providerIdentity.js';
import { DroidexDatabase } from './DroidexDatabase.js';
import { failureFromColumns, SUMMARY_JSON_KEYS } from './sessionSummaryJson.js';
import { SessionStore } from './SessionStore.js';
import { TranscriptStore } from './TranscriptStore.js';

const RECOVERY = 'move or remove this file, then restart DROIDEX';

function withStore(
  run: (store: SessionStore, db: DroidexDatabase, path: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-session-store-'));
  const path = join(dir, 'state', 'droidex.sqlite');
  const db = new DroidexDatabase(path);
  const store = new SessionStore(db);
  return Promise.resolve()
    .then(() => run(store, db, path))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function summary(appSessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
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
    ...overrides,
  };
}

function droidError(overrides: Partial<ProviderError> = {}): ProviderError {
  return {
    code: 'native_session_start_failed',
    providerInstanceId: 'droid',
    message: 'native start failed',
    recoveryAction: 'retry_session',
    ...overrides,
  };
}

function create(
  store: SessionStore,
  appSessionId: string,
  extras: { clientRef?: string; summary?: SessionSummary; now?: number } = {},
) {
  return store.createProvisional(
    {
      appSessionId,
      clientRef: extras.clientRef ?? `ref-${appSessionId}`,
      summary: extras.summary ?? summary(appSessionId),
    },
    extras.now,
  );
}

test('summary_json persists exactly the mutable public key set', async () => {
  await withStore((store, db) => {
    create(store, 'app-1');
    const row = db
      .prepare('SELECT summary_json FROM sessions WHERE app_session_id = ?')
      .get('app-1') as {
      summary_json: string;
    };
    const parsed: unknown = JSON.parse(row.summary_json);
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    const keys = Object.keys(parsed).sort();
    for (const key of keys) {
      assert.ok(
        (SUMMARY_JSON_KEYS as readonly string[]).includes(key),
        `unexpected summary_json key ${key}`,
      );
    }
    assert.equal('appSessionId' in parsed, false);
    assert.equal('createdAt' in parsed, false);
    assert.equal('updatedAt' in parsed, false);
    assert.equal('phase' in parsed, true);
    assert.equal('configuration' in parsed, true);
    assert.equal('sessionWebUrl' in parsed, false);
    assert.equal('providerSessionId' in parsed, false);
    assert.equal('compactedFromProviderSessionIds' in parsed, false);
    assert.deepEqual(SUMMARY_JSON_KEYS.slice().sort(), [
      'autoCompactions',
      'compactionModel',
      'compactionTokenLimit',
      'configuration',
      'contextAccuracy',
      'contextRemainingTokens',
      'contextTokens',
      'contextUpdatedAt',
      'cwd',
      'droidMissionConfiguration',
      'features',
      'goal',
      'interruptReason',
      'maxContextTokens',
      'missionId',
      'phase',
      'proposal',
      'queuedSends',
      'role',
      'sessionPurpose',
      'streaming',
      'title',
      'tokensIn',
      'tokensOut',
      'workspaceKind',
    ]);
  });
});

test('strict summary and resume JSON reject unknown keys and invalid payloads', async () => {
  await withStore((store, db) => {
    create(store, 'app-1');
    db.prepare('UPDATE sessions SET summary_json = ? WHERE app_session_id = ?').run(
      JSON.stringify({
        sessionPurpose: 'chat',
        role: 'primary',
        title: 'x',
        goal: '',
        cwd: '',
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
        appSessionId: 'sneaky',
      }),
      'app-1',
    );
    assert.throws(() => store.get('app-1'), /corrupt sessions row.*appSessionId/s);

    create(store, 'app-2');
    store.bindInitialProviderRuntime('app-2', 0, 'native-ok', { cursor: 1 });
    assert.throws(
      () => store.updateResumeState('app-2', 1, { toJSON: () => undefined }),
      /resume state is not valid JSON|JSON/,
    );
  });
});

test('duplicate app id and durable duplicate clientRef are rejected', async () => {
  await withStore((store) => {
    create(store, 'app-1', { clientRef: 'ref-a' });
    assert.throws(() => create(store, 'app-1', { clientRef: 'ref-b' }), /already exists/);
    assert.throws(
      () => create(store, 'app-2', { clientRef: 'ref-a' }),
      /clientRef ref-a already exists/,
    );
    assert.equal(store.findByClientRef('ref-a')?.summary.appSessionId, 'app-1');
    assert.equal(store.findByClientRef('missing'), undefined);
  });
});

test('list returns reverse activity order', async () => {
  await withStore((store) => {
    create(store, 'older', { now: 10 });
    create(store, 'newer', { now: 30 });
    create(store, 'middle', { now: 20 });
    assert.deepEqual(
      store.list().map((session) => session.summary.appSessionId),
      ['newer', 'middle', 'older'],
    );
  });
});

test('successful and stale-generation binding CAS', async () => {
  await withStore((store) => {
    const created = create(store, 'app-1');
    assert.equal(created.binding.runtimeGeneration, 0);
    assert.equal(created.binding.providerSessionId, undefined);
    const bound = store.bindInitialProviderRuntime('app-1', 0, 'native-1', { cursor: 'a' });
    assert.equal(bound.binding.providerSessionId, 'native-1');
    assert.equal(bound.binding.runtimeGeneration, 1);
    assert.deepEqual(bound.binding.resumeState, { cursor: 'a' });
    assert.throws(
      () => store.bindInitialProviderRuntime('app-1', 0, 'native-2'),
      /generation 1 does not match expected 0/,
    );
    assert.equal(store.get('app-1')?.binding.providerSessionId, 'native-1');
    assert.throws(
      () => store.bindInitialProviderRuntime('app-1', 1, 'native-2'),
      /already has an initial provider runtime/,
    );
  });
});

test('same-generation resume-state update does not increment generation', async () => {
  await withStore((store) => {
    create(store, 'app-1');
    store.bindInitialProviderRuntime('app-1', 0, 'native-1', { cursor: 'old' });
    const updated = store.updateResumeState('app-1', 1, { cursor: 'new', extra: true });
    assert.equal(updated.binding.runtimeGeneration, 1);
    assert.deepEqual(updated.binding.resumeState, { cursor: 'new', extra: true });
    assert.equal(updated.binding.providerSessionId, 'native-1');
    assert.throws(
      () => store.updateResumeState('app-1', 0, { cursor: 'stale' }),
      /does not match expected 0/,
    );
    assert.deepEqual(store.get('app-1')?.binding.resumeState, { cursor: 'new', extra: true });
  });
});

test('native replacement increments generation and appends the previous id', async () => {
  await withStore((store) => {
    create(store, 'app-1');
    store.bindInitialProviderRuntime('app-1', 0, 'native-old', { v: 1 });
    const replaced = store.replaceProviderRuntime('app-1', 1, 'native-new', { v: 2 });
    assert.equal(replaced.binding.providerSessionId, 'native-new');
    assert.deepEqual(replaced.binding.previousProviderSessionIds, ['native-old']);
    assert.equal(replaced.binding.runtimeGeneration, 2);
    assert.deepEqual(replaced.binding.resumeState, { v: 2 });
    assert.equal(replaced.summary.configuration.providerSelection.providerInstanceId, 'droid');
    const again = store.replaceProviderRuntime('app-1', 2, 'native-third');
    assert.deepEqual(again.binding.previousProviderSessionIds, ['native-old', 'native-new']);
    assert.equal(again.binding.runtimeGeneration, 3);
    assert.throws(
      () => store.replaceProviderRuntime('app-1', 1, 'stale'),
      /does not match expected 1/,
    );
  });
});

test('binding immutability is enforced in SQL and application code', async () => {
  await withStore((store, db) => {
    create(store, 'app-1');
    assert.throws(
      () =>
        store.updateSummary('app-1', {
          configuration: {
            providerSelection: {
              providerInstanceId: 'codex',
              modelId: 'gpt',
              options: {},
            },
            interactionMode: 'auto',
            autonomy: 'low',
          },
        }),
      /cannot change the nested provider instance/,
    );
    assert.throws(
      () =>
        db
          .prepare('UPDATE sessions SET provider_instance_id = ? WHERE app_session_id = ?')
          .run('codex', 'app-1'),
      /immutable/i,
    );
    assert.throws(
      () =>
        db
          .prepare('UPDATE sessions SET provider_driver_kind = ? WHERE app_session_id = ?')
          .run('codex', 'app-1'),
      /immutable/i,
    );
    assert.throws(
      () =>
        db
          .prepare('UPDATE sessions SET app_session_id = ? WHERE app_session_id = ?')
          .run('app-other', 'app-1'),
      /immutable/i,
    );
    const stored = store.get('app-1');
    assert.equal(stored?.binding.providerInstanceId, 'droid');
    assert.equal(stored?.binding.providerDriverKind, 'droid');
  });
});

test('two different instances may each bind native id native-1', async () => {
  await withStore((store) => {
    create(store, 'droid-app', {
      summary: summary('droid-app', {
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      }),
    });
    create(store, 'codex-app', {
      summary: summary('codex-app', {
        configuration: {
          providerSelection: { providerInstanceId: 'codex', modelId: 'gpt-5', options: {} },
          interactionMode: 'auto',
          autonomy: 'low',
        },
      }),
    });
    store.bindInitialProviderRuntime('droid-app', 0, 'native-1');
    store.bindInitialProviderRuntime('codex-app', 0, 'native-1');
    assert.equal(store.get('droid-app')?.binding.providerSessionId, 'native-1');
    assert.equal(store.get('codex-app')?.binding.providerSessionId, 'native-1');
    assert.equal(store.get('droid-app')?.binding.providerInstanceId, 'droid');
    assert.equal(store.get('codex-app')?.binding.providerInstanceId, 'codex');
  });
});

test('lookup, update, and hide target app id only', async () => {
  await withStore((store) => {
    create(store, 'app-1');
    store.bindInitialProviderRuntime('app-1', 0, 'native-1');
    assert.equal(store.get('native-1'), undefined);
    assert.equal(store.get('app-1')?.summary.title, 'app-1');
    store.updateSummary('app-1', { title: 'Renamed' });
    assert.equal(store.get('app-1')?.summary.title, 'Renamed');
    assert.throws(
      () => store.updateSummary('native-1', { title: 'Nope' }),
      /not in the canonical store/,
    );
    store.setHidden('app-1', true);
    assert.deepEqual(
      store.list().map((session) => session.summary.appSessionId),
      [],
    );
    assert.equal(store.get('app-1')?.hidden, true);
  });
});

test('serialized SessionSummary omits native ids and projects sessionWebUrl for Droid only', async () => {
  await withStore((store) => {
    create(store, 'droid-app');
    const unbound = store.get('droid-app');
    assert.equal(unbound?.summary.sessionWebUrl, undefined);
    assert.equal(unbound?.summary.sessionRef, undefined);
    store.bindInitialProviderRuntime('droid-app', 0, 'native-1');
    const droid = store.get('droid-app')?.summary;
    assert.ok(droid);
    const wire = JSON.parse(JSON.stringify(droid)) as Record<string, unknown>;
    assert.equal('providerSessionId' in wire, false);
    assert.equal('compactedFromProviderSessionIds' in wire, false);
    assert.equal(wire.sessionWebUrl, 'https://app.factory.ai/sessions/native-1');
    assert.deepEqual(wire.sessionRef, { id: 'native-1', resumeCommand: "droid -r 'native-1'" });
    assert.equal(wire.appSessionId, 'droid-app');
    assert.equal(JSON.stringify(wire).includes('"providerSessionId"'), false);

    create(store, 'cursor-app', {
      summary: summary('cursor-app', {
        configuration: {
          providerSelection: { providerInstanceId: 'cursor', modelId: 'composer', options: {} },
          interactionMode: 'auto',
          autonomy: 'low',
        },
      }),
    });
    store.bindInitialProviderRuntime('cursor-app', 0, 'native-1');
    const cursor = store.get('cursor-app')?.summary;
    assert.ok(cursor);
    assert.equal(cursor.sessionWebUrl, undefined);
    assert.equal(cursor.sessionRef, undefined);
    assert.equal('providerSessionId' in cursor, false);
    assert.equal(JSON.stringify(cursor).includes('native-1'), false);
  });
});

test('strict structured-failure round-trip and rejection cases', async () => {
  await withStore((store) => {
    create(store, 'app-1');
    const failed = store.markFailed('app-1', droidError());
    assert.deepEqual(failed.failure, droidError());
    assert.equal(failed.lifecycleStatus, 'failed');
    const rehydrated = store.get('app-1');
    assert.deepEqual(rehydrated?.failure, droidError());
    assert.equal(JSON.stringify(rehydrated).includes('nativeError'), false);

    assert.throws(
      () => store.markFailed('app-1', droidError({ providerInstanceId: 'codex' })),
      /does not match session app-1 instance droid/,
    );
    assert.throws(
      () =>
        store.markFailed('app-1', {
          ...droidError(),
          native: { stack: 'secret' },
        } as ProviderError),
      /unrecognized_keys|strict/i,
    );

    assert.throws(
      () =>
        failureFromColumns({
          failure_code: 'not_a_real_code',
          failure_message: 'boom',
          failure_recovery_action: 'retry_session',
          provider_instance_id: 'droid',
        }),
      /Invalid enum value|invalid_enum/i,
    );
    assert.throws(
      () =>
        failureFromColumns({
          failure_code: 'native_session_start_failed',
          failure_message: 'boom',
          failure_recovery_action: 'explode',
          provider_instance_id: 'droid',
        }),
      /Invalid enum value|invalid_enum/i,
    );
  });
});

test('corrupt canonical row reports the database path and reset recovery', async () => {
  await withStore((store, db, path) => {
    create(store, 'app-1');
    db.prepare('UPDATE sessions SET summary_json = ? WHERE app_session_id = ?').run('[]', 'app-1');
    assert.throws(
      () => store.get('app-1'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, new RegExp(RECOVERY));
        return true;
      },
    );
  });
});

test('SessionStore has no close and does not own turns', async () => {
  await withStore((store, db) => {
    assert.equal(typeof (store as { close?: unknown }).close, 'undefined');
    create(store, 'app-1');
    const turns = db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
    assert.equal(turns.n, 0);
  });
});

test('createProvisional and beginTurn share one transaction and roll back together', async () => {
  await withStore((store, db) => {
    const transcript = new TranscriptStore(db);
    assert.throws(() =>
      db.transaction(() => {
        create(store, 'app-tx', { clientRef: 'ref-tx' });
        transcript.beginTurn({
          turnId: 'turn-tx',
          target: { kind: 'session', appSessionId: 'app-tx' },
          runtimeGeneration: 1,
          startedAt: '1000',
        });
        throw new Error('force rollback');
      }),
    );
    assert.equal(store.get('app-tx'), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n, 0);
  });
});

test('child upsert and read round-trip a private binding', async () => {
  await withStore((store) => {
    create(store, 'app-1');
    const child = store.upsertChild({
      parentAppSessionId: 'app-1',
      childSessionId: 'child-1',
      summary: {
        parentAppSessionId: 'app-1',
        childSessionId: 'child-1',
        role: 'worker',
        status: 'running',
        modelId: 'model-default',
        transcriptAvailable: true,
        streamFidelity: 'token',
      },
      binding: {
        providerDriverKind: 'droid',
        providerInstanceId: 'droid',
        providerSessionId: 'native-child',
      },
    });
    assert.equal(child.binding.providerSessionId, 'native-child');
    assert.equal(child.summary.childSessionId, 'child-1');
    assert.equal(store.getChild('app-1', 'child-1')?.binding.providerSessionId, 'native-child');
  });
});

test('beginRetryStart CAS-clears a failed row and increments generation', async () => {
  await withStore((store) => {
    create(store, 'app-1');
    store.bindInitialProviderRuntime('app-1', 0, 'native-1');
    store.markFailed('app-1', droidError());
    const retried = store.beginRetryStart('app-1', 50);
    assert.equal(retried.lifecycleStatus, 'initializing');
    assert.equal(retried.failure, undefined);
    assert.equal(retried.binding.runtimeGeneration, 2);
    assert.equal(retried.binding.providerSessionId, 'native-1');
    assert.equal(retried.summary.configuration.providerSelection.providerInstanceId, 'droid');
    assert.throws(() => store.beginRetryStart('app-1'), /lifecycle initializing cannot retry start/);
  });
});

test('beginRetryStart rejects missing and non-failed sessions', async () => {
  await withStore((store) => {
    assert.throws(() => store.beginRetryStart('missing'), /Session missing is not in the canonical store/);
    create(store, 'app-1');
    assert.throws(() => store.beginRetryStart('app-1'), /lifecycle initializing cannot retry start/);
    store.markStarted('app-1');
    assert.throws(() => store.beginRetryStart('app-1'), /lifecycle running cannot retry start/);
  });
});

test('removeFailed deletes only that failed session and cascades canonical rows', async () => {
  await withStore((store, db) => {
    const transcript = new TranscriptStore(db);
    create(store, 'keep');
    create(store, 'drop');
    store.upsertChild({
      parentAppSessionId: 'drop',
      childSessionId: 'child-drop',
      summary: {
        parentAppSessionId: 'drop',
        childSessionId: 'child-drop',
        role: 'worker',
        status: 'running',
        modelId: 'model-default',
        transcriptAvailable: false,
        streamFidelity: 'token',
      },
      binding: { providerDriverKind: 'droid', providerInstanceId: 'droid' },
    });
    transcript.beginTurn({
      turnId: 'turn-drop',
      target: { kind: 'session', appSessionId: 'drop' },
      runtimeGeneration: 1,
      startedAt: '1000',
    });
    transcript.append({
      eventId: 'evt-drop',
      target: { kind: 'session', appSessionId: 'drop' },
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      runtimeGeneration: 1,
      createdAt: 1,
      turnId: 'turn-drop',
      payload: {
        type: 'error',
        error: droidError(),
      },
    });
    store.markFailed('drop', droidError());
    store.removeFailed('drop');
    assert.equal(store.get('drop'), undefined);
    assert.equal(store.getChild('drop', 'child-drop'), undefined);
    assert.equal(store.get('keep')?.summary.appSessionId, 'keep');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM transcript_events').get() as { n: number }).n,
      0,
    );
    assert.throws(() => store.removeFailed('keep'), /lifecycle initializing cannot be removed/);
    assert.throws(() => store.removeFailed('drop'), /Session drop is not in the canonical store/);
  });
});

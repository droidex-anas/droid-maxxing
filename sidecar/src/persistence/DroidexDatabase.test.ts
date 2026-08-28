import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { droidexDatabasePath } from '../droidexPaths.js';
import {
  providerErrorCodeSchema,
  providerRecoveryActionSchema,
} from '../providers/providerErrors.js';
import {
  providerDriverKindSchema,
  providerInstanceIdSchema,
} from '../providers/providerIdentity.js';
import { DROIDEX_SCHEMA_VERSION, DroidexDatabase } from './DroidexDatabase.js';
import {
  FAILURE_ACTION_CHECK,
  FAILURE_CODE_CHECK,
  PROVIDER_PAIR_CHECK,
  providerPairCheckSql,
  sqlInList,
} from './droidexSchema.js';

const RECOVERY = 'move or remove this file, then restart DROIDEX';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const SESSION_INSERT = `
  INSERT INTO sessions (
    app_session_id, client_ref, provider_driver_kind, provider_instance_id,
    provider_session_id, previous_provider_session_ids_json, resume_state_json,
    runtime_generation, summary_json, lifecycle_status, failure_code, failure_message,
    failure_recovery_action, hidden, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-canonical-db-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withDb(run: (db: DroidexDatabase, path: string) => void): void {
  withTempDir((dir) => {
    const path = join(dir, 'state', 'droidex.sqlite');
    const db = new DroidexDatabase(path);
    try {
      run(db, path);
    } finally {
      db.close();
    }
  });
}

function openRaw(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function columns(db: DroidexDatabase, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
}

function columnShape(
  rows: { name: string; type: string; notnull: number; pk: number }[],
): Array<[string, string, number, number]> {
  return rows.map((row) => [row.name, row.type, row.notnull, row.pk]);
}

function schemaSql(db: DroidexDatabase, type: string, name: string): string {
  const row = db
    .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
    .get(type, name) as { sql: string | null } | undefined;
  assert.ok(row?.sql, `${type} ${name} is missing`);
  return normalizeSql(row.sql);
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

function indexMeta(db: DroidexDatabase, table: string, name: string) {
  const list = db.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
    partial: number;
  }[];
  const index = list.find((row) => row.name === name);
  assert.ok(index, `index ${name} is missing on ${table}`);
  const info = db.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[];
  const sql = schemaSql(db, 'index', name);
  return {
    unique: index.unique,
    partial: index.partial,
    columns: info.map((row) => row.name),
    sql,
  };
}

function foreignKeys(db: DroidexDatabase, table: string) {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }[];
  const grouped = new Map<
    number,
    { table: string; from: string[]; to: string[]; onDelete: string }
  >();
  for (const row of rows) {
    const current = grouped.get(row.id) ?? {
      table: row.table,
      from: [],
      to: [],
      onDelete: row.on_delete,
    };
    current.from[row.seq] = row.from;
    current.to[row.seq] = row.to;
    grouped.set(row.id, current);
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.table}:${left.from.join(',')}` < `${right.table}:${right.from.join(',')}` ? -1 : 1,
  );
}

function insertSession(
  db: DroidexDatabase,
  overrides: {
    appSessionId?: string;
    clientRef?: string;
    driver?: string;
    instance?: string;
    nativeId?: string | null;
    replacements?: string;
    resume?: string | null;
    generation?: number;
    summary?: string;
    lifecycle?: string;
    failureCode?: string | null;
    failureMessage?: string | null;
    failureAction?: string | null;
    hidden?: number;
    createdAt?: number;
    updatedAt?: number;
  } = {},
): void {
  db.prepare(SESSION_INSERT).run(
    overrides.appSessionId ?? 'sess-1',
    overrides.clientRef ?? 'ref-1',
    overrides.driver ?? 'droid',
    overrides.instance ?? 'droid',
    overrides.nativeId === undefined ? 'native-1' : overrides.nativeId,
    overrides.replacements ?? '[]',
    overrides.resume === undefined ? null : overrides.resume,
    overrides.generation ?? 0,
    overrides.summary ?? '{}',
    overrides.lifecycle ?? 'running',
    overrides.failureCode === undefined ? null : overrides.failureCode,
    overrides.failureMessage === undefined ? null : overrides.failureMessage,
    overrides.failureAction === undefined ? null : overrides.failureAction,
    overrides.hidden ?? 0,
    overrides.createdAt ?? 1,
    overrides.updatedAt ?? 1,
  );
}

function insertChild(
  db: DroidexDatabase,
  overrides: {
    parent?: string;
    child?: string;
    driver?: string;
    instance?: string;
    nativeId?: string | null;
    replacements?: string;
    resume?: string | null;
    generation?: number;
    summary?: string;
    lifecycle?: string;
    createdAt?: number;
    updatedAt?: number;
  } = {},
): void {
  db.prepare(
    `
      INSERT INTO child_sessions (
        parent_app_session_id, child_session_id, provider_driver_kind, provider_instance_id,
        provider_session_id, previous_provider_session_ids_json, resume_state_json,
        runtime_generation, summary_json, lifecycle_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    overrides.parent ?? 'sess-1',
    overrides.child ?? 'child-1',
    overrides.driver ?? 'droid',
    overrides.instance ?? 'droid',
    overrides.nativeId === undefined ? 'child-native-1' : overrides.nativeId,
    overrides.replacements ?? '[]',
    overrides.resume === undefined ? null : overrides.resume,
    overrides.generation ?? 0,
    overrides.summary ?? '{}',
    overrides.lifecycle ?? 'running',
    overrides.createdAt ?? 1,
    overrides.updatedAt ?? 1,
  );
}

function insertTurn(
  db: DroidexDatabase,
  overrides: {
    turnId?: string;
    parent?: string;
    targetKind?: string;
    child?: string | null;
    generation?: number;
    lifecycle?: string;
    providerTurnId?: string | null;
    startedAt?: number;
    settledAt?: number | null;
  } = {},
): void {
  db.prepare(
    `
      INSERT INTO turns (
        turn_id, parent_app_session_id, target_kind, child_session_id, runtime_generation,
        lifecycle_status, provider_turn_id, started_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    overrides.turnId ?? 'turn-1',
    overrides.parent ?? 'sess-1',
    overrides.targetKind ?? 'session',
    overrides.child === undefined ? null : overrides.child,
    overrides.generation ?? 0,
    overrides.lifecycle ?? 'pending',
    overrides.providerTurnId === undefined ? null : overrides.providerTurnId,
    overrides.startedAt ?? 1,
    overrides.settledAt === undefined ? null : overrides.settledAt,
  );
}

function insertEvent(
  db: DroidexDatabase,
  overrides: {
    eventId?: string;
    parent?: string;
    targetKind?: string;
    child?: string | null;
    turnId?: string | null;
    generation?: number;
    driver?: string;
    instance?: string;
    nativeSession?: string | null;
    nativeTurn?: string | null;
    nativeItem?: string | null;
    payload?: string;
    searchText?: string;
    createdAt?: number;
  } = {},
): void {
  db.prepare(
    `
      INSERT INTO transcript_events (
        event_id, parent_app_session_id, target_kind, child_session_id, turn_id,
        runtime_generation, provider_driver_kind, provider_instance_id, provider_session_id,
        provider_turn_id, provider_item_id, payload_json, search_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    overrides.eventId ?? 'event-1',
    overrides.parent ?? 'sess-1',
    overrides.targetKind ?? 'session',
    overrides.child === undefined ? null : overrides.child,
    overrides.turnId === undefined ? null : overrides.turnId,
    overrides.generation ?? 0,
    overrides.driver ?? 'droid',
    overrides.instance ?? 'droid',
    overrides.nativeSession === undefined ? null : overrides.nativeSession,
    overrides.nativeTurn === undefined ? null : overrides.nativeTurn,
    overrides.nativeItem === undefined ? null : overrides.nativeItem,
    overrides.payload ?? '{}',
    overrides.searchText ?? '',
    overrides.createdAt ?? 1,
  );
}

function assertConstraint(run: () => void): void {
  assert.throws(run, (error: unknown) => error instanceof Error);
}

function assertRecovery(run: () => void, path: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path), error.message);
    assert.ok(error.message.includes(RECOVERY), error.message);
    return true;
  });
}

test('droidexDatabasePath resolves under DROIDEX_USER_DATA_DIR', () => {
  withTempDir((dir) => {
    const previous = process.env.DROIDEX_USER_DATA_DIR;
    process.env.DROIDEX_USER_DATA_DIR = dir;
    try {
      assert.equal(droidexDatabasePath(), join(dir, 'state', 'droidex.sqlite'));
      const db = new DroidexDatabase();
      db.close();
      const raw = openRaw(join(dir, 'state', 'droidex.sqlite'));
      assert.equal(
        (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        1,
      );
      raw.close();
    } finally {
      if (previous === undefined) delete process.env.DROIDEX_USER_DATA_DIR;
      else process.env.DROIDEX_USER_DATA_DIR = previous;
    }
  });
});

test('schema version, WAL, foreign keys, and busy_timeout are exact', () => {
  withDb((db) => {
    assert.equal(DROIDEX_SCHEMA_VERSION, 1);
    assert.equal(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      1,
    );
    assert.equal(
      (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      'wal',
    );
    assert.equal(
      (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
      1,
    );
    assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
  });
});

test('every table has the exact frozen columns, types, nullability, and primary keys', () => {
  withDb((db) => {
    assert.deepEqual(columnShape(columns(db, 'sessions')), [
      ['app_session_id', 'TEXT', 0, 1],
      ['client_ref', 'TEXT', 1, 0],
      ['provider_driver_kind', 'TEXT', 1, 0],
      ['provider_instance_id', 'TEXT', 1, 0],
      ['provider_session_id', 'TEXT', 0, 0],
      ['previous_provider_session_ids_json', 'TEXT', 1, 0],
      ['resume_state_json', 'TEXT', 0, 0],
      ['runtime_generation', 'INTEGER', 1, 0],
      ['summary_json', 'TEXT', 1, 0],
      ['lifecycle_status', 'TEXT', 1, 0],
      ['failure_code', 'TEXT', 0, 0],
      ['failure_message', 'TEXT', 0, 0],
      ['failure_recovery_action', 'TEXT', 0, 0],
      ['hidden', 'INTEGER', 1, 0],
      ['created_at', 'INTEGER', 1, 0],
      ['updated_at', 'INTEGER', 1, 0],
    ]);
    assert.deepEqual(columnShape(columns(db, 'child_sessions')), [
      ['parent_app_session_id', 'TEXT', 1, 1],
      ['child_session_id', 'TEXT', 1, 2],
      ['provider_driver_kind', 'TEXT', 1, 0],
      ['provider_instance_id', 'TEXT', 1, 0],
      ['provider_session_id', 'TEXT', 0, 0],
      ['previous_provider_session_ids_json', 'TEXT', 1, 0],
      ['resume_state_json', 'TEXT', 0, 0],
      ['runtime_generation', 'INTEGER', 1, 0],
      ['summary_json', 'TEXT', 1, 0],
      ['lifecycle_status', 'TEXT', 1, 0],
      ['created_at', 'INTEGER', 1, 0],
      ['updated_at', 'INTEGER', 1, 0],
    ]);
    assert.deepEqual(columnShape(columns(db, 'turns')), [
      ['turn_id', 'TEXT', 0, 1],
      ['parent_app_session_id', 'TEXT', 1, 0],
      ['target_kind', 'TEXT', 1, 0],
      ['child_session_id', 'TEXT', 0, 0],
      ['runtime_generation', 'INTEGER', 1, 0],
      ['lifecycle_status', 'TEXT', 1, 0],
      ['provider_turn_id', 'TEXT', 0, 0],
      ['started_at', 'INTEGER', 1, 0],
      ['settled_at', 'INTEGER', 0, 0],
    ]);
    assert.deepEqual(columnShape(columns(db, 'transcript_events')), [
      ['event_order', 'INTEGER', 0, 1],
      ['event_id', 'TEXT', 1, 0],
      ['parent_app_session_id', 'TEXT', 1, 0],
      ['target_kind', 'TEXT', 1, 0],
      ['child_session_id', 'TEXT', 0, 0],
      ['turn_id', 'TEXT', 0, 0],
      ['runtime_generation', 'INTEGER', 1, 0],
      ['provider_driver_kind', 'TEXT', 1, 0],
      ['provider_instance_id', 'TEXT', 1, 0],
      ['provider_session_id', 'TEXT', 0, 0],
      ['provider_turn_id', 'TEXT', 0, 0],
      ['provider_item_id', 'TEXT', 0, 0],
      ['payload_json', 'TEXT', 1, 0],
      ['search_text', 'TEXT', 1, 0],
      ['created_at', 'INTEGER', 1, 0],
    ]);
  });
});

test('named indexes have exact columns and partial predicates', () => {
  withDb((db) => {
    assert.deepEqual(indexMeta(db, 'sessions', 'sessions_client_ref_unique'), {
      unique: 1,
      partial: 0,
      columns: ['client_ref'],
      sql: normalizeSql('CREATE UNIQUE INDEX sessions_client_ref_unique ON sessions (client_ref)'),
    });
    assert.deepEqual(indexMeta(db, 'sessions', 'sessions_native_binding_unique'), {
      unique: 1,
      partial: 1,
      columns: ['provider_instance_id', 'provider_session_id'],
      sql: normalizeSql(
        'CREATE UNIQUE INDEX sessions_native_binding_unique ON sessions (provider_instance_id, provider_session_id) WHERE provider_session_id IS NOT NULL',
      ),
    });
    assert.deepEqual(indexMeta(db, 'sessions', 'sessions_activity'), {
      unique: 0,
      partial: 0,
      columns: ['hidden', 'updated_at', 'app_session_id'],
      sql: normalizeSql(
        'CREATE INDEX sessions_activity ON sessions (hidden, updated_at DESC, app_session_id)',
      ),
    });
    assert.deepEqual(indexMeta(db, 'child_sessions', 'child_sessions_native_binding_unique'), {
      unique: 1,
      partial: 1,
      columns: ['provider_instance_id', 'provider_session_id'],
      sql: normalizeSql(
        'CREATE UNIQUE INDEX child_sessions_native_binding_unique ON child_sessions (provider_instance_id, provider_session_id) WHERE provider_session_id IS NOT NULL',
      ),
    });
    assert.deepEqual(indexMeta(db, 'child_sessions', 'child_sessions_activity'), {
      unique: 0,
      partial: 0,
      columns: ['parent_app_session_id', 'updated_at', 'child_session_id'],
      sql: normalizeSql(
        'CREATE INDEX child_sessions_activity ON child_sessions (parent_app_session_id, updated_at DESC, child_session_id)',
      ),
    });
    assert.deepEqual(indexMeta(db, 'turns', 'turns_target_activity'), {
      unique: 0,
      partial: 0,
      columns: ['parent_app_session_id', 'child_session_id', 'started_at', 'turn_id'],
      sql: normalizeSql(
        'CREATE INDEX turns_target_activity ON turns (parent_app_session_id, child_session_id, started_at DESC, turn_id)',
      ),
    });
    assert.deepEqual(indexMeta(db, 'transcript_events', 'transcript_events_session_page'), {
      unique: 0,
      partial: 1,
      columns: ['parent_app_session_id', 'event_order'],
      sql: normalizeSql(
        'CREATE INDEX transcript_events_session_page ON transcript_events (parent_app_session_id, event_order) WHERE child_session_id IS NULL',
      ),
    });
    assert.deepEqual(indexMeta(db, 'transcript_events', 'transcript_events_child_page'), {
      unique: 0,
      partial: 1,
      columns: ['parent_app_session_id', 'child_session_id', 'event_order'],
      sql: normalizeSql(
        'CREATE INDEX transcript_events_child_page ON transcript_events (parent_app_session_id, child_session_id, event_order) WHERE child_session_id IS NOT NULL',
      ),
    });
  });
});

test('named triggers have exact SQL', () => {
  withDb((db) => {
    assert.equal(
      schemaSql(db, 'trigger', 'sessions_immutable_identity'),
      normalizeSql(`
        CREATE TRIGGER sessions_immutable_identity
        BEFORE UPDATE ON sessions
        WHEN NEW.app_session_id IS NOT OLD.app_session_id
          OR NEW.provider_driver_kind IS NOT OLD.provider_driver_kind
          OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
        BEGIN
          SELECT RAISE(ABORT, 'sessions identity is immutable');
        END
      `),
    );
    assert.equal(
      schemaSql(db, 'trigger', 'child_sessions_immutable_identity'),
      normalizeSql(`
        CREATE TRIGGER child_sessions_immutable_identity
        BEFORE UPDATE ON child_sessions
        WHEN NEW.parent_app_session_id IS NOT OLD.parent_app_session_id
          OR NEW.child_session_id IS NOT OLD.child_session_id
          OR NEW.provider_driver_kind IS NOT OLD.provider_driver_kind
          OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
        BEGIN
          SELECT RAISE(ABORT, 'child_sessions identity is immutable');
        END
      `),
    );
  });
});

test('only the expected application tables, indexes, and triggers exist', () => {
  withDb((db) => {
    const objects = (
      db
        .prepare(
          `
            SELECT type, name FROM sqlite_schema
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
          `,
        )
        .all() as { type: string; name: string }[]
    ).map((row) => ({ type: row.type, name: row.name }));
    assert.deepEqual(objects, [
      { type: 'index', name: 'child_sessions_activity' },
      { type: 'index', name: 'child_sessions_native_binding_unique' },
      { type: 'index', name: 'sessions_activity' },
      { type: 'index', name: 'sessions_client_ref_unique' },
      { type: 'index', name: 'sessions_native_binding_unique' },
      { type: 'index', name: 'transcript_events_child_page' },
      { type: 'index', name: 'transcript_events_session_page' },
      { type: 'index', name: 'turns_target_activity' },
      { type: 'table', name: 'child_sessions' },
      { type: 'table', name: 'sessions' },
      { type: 'table', name: 'transcript_events' },
      { type: 'table', name: 'turns' },
      { type: 'trigger', name: 'child_sessions_immutable_identity' },
      { type: 'trigger', name: 'sessions_immutable_identity' },
    ]);
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    assert.deepEqual(
      tables.map((row) => row.name),
      ['child_sessions', 'sessions', 'sqlite_sequence', 'transcript_events', 'turns'],
    );
    assert.deepEqual(foreignKeys(db, 'child_sessions'), [
      {
        table: 'sessions',
        from: ['parent_app_session_id'],
        to: ['app_session_id'],
        onDelete: 'CASCADE',
      },
    ]);
    assert.deepEqual(foreignKeys(db, 'turns'), [
      {
        table: 'child_sessions',
        from: ['parent_app_session_id', 'child_session_id'],
        to: ['parent_app_session_id', 'child_session_id'],
        onDelete: 'CASCADE',
      },
      {
        table: 'sessions',
        from: ['parent_app_session_id'],
        to: ['app_session_id'],
        onDelete: 'CASCADE',
      },
    ]);
    assert.deepEqual(foreignKeys(db, 'transcript_events'), [
      {
        table: 'child_sessions',
        from: ['parent_app_session_id', 'child_session_id'],
        to: ['parent_app_session_id', 'child_session_id'],
        onDelete: 'CASCADE',
      },
      {
        table: 'sessions',
        from: ['parent_app_session_id'],
        to: ['app_session_id'],
        onDelete: 'CASCADE',
      },
      { table: 'turns', from: ['turn_id'], to: ['turn_id'], onDelete: 'CASCADE' },
    ]);
  });
});

test('deleting a session cascades to children, turns, and events', () => {
  withDb((db) => {
    insertSession(db);
    insertChild(db);
    insertTurn(db, { targetKind: 'child', child: 'child-1' });
    insertEvent(db, { targetKind: 'child', child: 'child-1', turnId: 'turn-1' });
    db.prepare('DELETE FROM sessions WHERE app_session_id = ?').run('sess-1');
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM child_sessions').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM turns').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM transcript_events').get() as { count: number })
        .count,
      0,
    );
  });
});

test('close is idempotent', () => {
  withTempDir((dir) => {
    const db = new DroidexDatabase(join(dir, 'droidex.sqlite'));
    db.close();
    db.close();
  });
});

test('transaction commits on success and rolls back on throw', () => {
  withDb((db) => {
    db.transaction(() => {
      insertSession(db, { appSessionId: 'ok', clientRef: 'ok' });
    });
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count,
      1,
    );
    assert.throws(() =>
      db.transaction(() => {
        insertSession(db, { appSessionId: 'fail', clientRef: 'fail' });
        throw new Error('boom');
      }),
    );
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count,
      1,
    );
    assert.throws(
      () =>
        db.transaction(() => {
          db.transaction(() => undefined);
        }),
      /nested/i,
    );
  });
});

test('rejects invalid driver/instance pairs, targets, lifecycle, failure, JSON, hidden, and timestamps', () => {
  withDb((db) => {
    insertSession(db);
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 's2',
        clientRef: 'r2',
        driver: 'droid',
        instance: 'codex',
      }),
    );
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 's2',
        clientRef: 'r2',
        driver: 'factory',
        instance: 'factory',
      }),
    );
    assertConstraint(() => insertSession(db, { appSessionId: '', clientRef: 'r2' }));
    assertConstraint(() => insertSession(db, { appSessionId: 'a'.repeat(257), clientRef: 'r2' }));
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', summary: 'not-json' }),
    );
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', replacements: '{}' }),
    );
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', replacements: 'null' }),
    );
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', resume: 'not-json' }),
    );
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', generation: -1 }),
    );
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', createdAt: -1 }),
    );
    assertConstraint(() => insertSession(db, { appSessionId: 's2', clientRef: 'r2', hidden: 2 }));
    assertConstraint(() => insertSession(db, { appSessionId: 's2', clientRef: 'r2', hidden: -1 }));
    assertConstraint(() =>
      insertSession(db, { appSessionId: 's2', clientRef: 'r2', lifecycle: 'intake' }),
    );
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 's2',
        clientRef: 'r2',
        lifecycle: 'failed',
        failureCode: 'missing_executable',
        failureMessage: 'missing',
      }),
    );
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 's2',
        clientRef: 'r2',
        lifecycle: 'running',
        failureCode: 'missing_executable',
        failureMessage: 'missing',
        failureAction: 'open_droid_setup',
      }),
    );
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 's2',
        clientRef: 'r2',
        lifecycle: 'failed',
        failureCode: 'native_error',
        failureMessage: 'missing',
        failureAction: 'open_droid_setup',
      }),
    );
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 's2',
        clientRef: 'r2',
        lifecycle: 'failed',
        failureCode: 'missing_executable',
        failureMessage: 'missing',
        failureAction: 'reboot',
      }),
    );
    insertSession(db, {
      appSessionId: 'failed',
      clientRef: 'failed',
      nativeId: null,
      lifecycle: 'failed',
      failureCode: 'missing_executable',
      failureMessage: 'Droid CLI is missing',
      failureAction: 'open_droid_setup',
    });

    insertChild(db);
    assertConstraint(() =>
      insertChild(db, { child: 'child-2', driver: 'claude', instance: 'droid' }),
    );
    assertConstraint(() => insertTurn(db, { targetKind: 'other' }));
    assertConstraint(() => insertTurn(db, { targetKind: 'child', child: null }));
    assertConstraint(() => insertTurn(db, { targetKind: 'session', child: 'child-1' }));
    assertConstraint(() => insertTurn(db, { lifecycle: 'running', settledAt: 2 }));
    assertConstraint(() => insertTurn(db, { lifecycle: 'completed', settledAt: null }));
    assertConstraint(() => insertTurn(db, { lifecycle: 'done', settledAt: 2 }));
    insertTurn(db, { lifecycle: 'pending' });
    insertTurn(db, { turnId: 'turn-done', lifecycle: 'completed', settledAt: 2 });
    assertConstraint(() => insertEvent(db, { payload: 'not-json' }));
    assertConstraint(() => insertEvent(db, { targetKind: 'child', child: null }));
    insertEvent(db, { payload: '{"type":"turn.started"}' });
  });
});

test('immutability triggers reject identity changes', () => {
  withDb((db) => {
    insertSession(db);
    insertChild(db);
    assert.throws(() => db.prepare('UPDATE sessions SET app_session_id = ?').run('other'));
    assert.throws(() =>
      db
        .prepare('UPDATE sessions SET provider_driver_kind = ?, provider_instance_id = ?')
        .run('codex', 'codex'),
    );
    assert.throws(() => db.prepare('UPDATE sessions SET provider_instance_id = ?').run('codex'));
    assert.throws(() =>
      db.prepare('UPDATE child_sessions SET child_session_id = ?').run('other-child'),
    );
    assert.throws(() =>
      db
        .prepare('UPDATE child_sessions SET provider_driver_kind = ?, provider_instance_id = ?')
        .run('claude', 'claude'),
    );
    db.prepare('UPDATE sessions SET summary_json = ?').run('{"title":"ok"}');
  });
});

test('native IDs are unique per provider instance, not globally', () => {
  withDb((db) => {
    insertSession(db, { appSessionId: 'droid-sess', clientRef: 'droid-ref', nativeId: 'native-1' });
    insertSession(db, {
      appSessionId: 'codex-sess',
      clientRef: 'codex-ref',
      driver: 'codex',
      instance: 'codex',
      nativeId: 'native-1',
    });
    assertConstraint(() =>
      insertSession(db, {
        appSessionId: 'droid-again',
        clientRef: 'droid-again',
        nativeId: 'native-1',
      }),
    );
    insertSession(db, { appSessionId: 'droid-null', clientRef: 'droid-null', nativeId: null });
    insertSession(db, {
      appSessionId: 'droid-null-2',
      clientRef: 'droid-null-2',
      nativeId: null,
    });
  });
});

test('nonempty version-0 and wrong-version files fail with the exact path and recovery text', () => {
  withTempDir((dir) => {
    const versionZero = join(dir, 'zero.sqlite');
    const rawZero = openRaw(versionZero);
    rawZero.exec('CREATE TABLE leftover (id INTEGER PRIMARY KEY)');
    rawZero.close();
    assertRecovery(() => new DroidexDatabase(versionZero), versionZero);

    const wrongVersion = join(dir, 'wrong.sqlite');
    const created = new DroidexDatabase(wrongVersion);
    created.close();
    const rawWrong = openRaw(wrongVersion);
    rawWrong.exec('PRAGMA user_version = 99');
    rawWrong.close();
    assertRecovery(() => new DroidexDatabase(wrongVersion), wrongVersion);

    const extraTable = join(dir, 'extra.sqlite');
    const valid = new DroidexDatabase(extraTable);
    valid.close();
    const rawExtra = openRaw(extraTable);
    rawExtra.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)');
    rawExtra.close();
    assertRecovery(() => new DroidexDatabase(extraTable), extraTable);

    const narrowerPairs = join(dir, 'narrower-pairs.sqlite');
    const current = new DroidexDatabase(narrowerPairs);
    current.close();
    const rawNarrow = openRaw(narrowerPairs);
    const sessionsSql = (
      rawNarrow
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'")
        .get() as { sql: string }
    ).sql;
    const narrowed = sessionsSql.replace(
      "\n    OR (provider_driver_kind = 'claude' AND provider_instance_id = 'claude')",
      '',
    );
    assert.notEqual(narrowed, sessionsSql);
    rawNarrow.exec('PRAGMA writable_schema = ON');
    rawNarrow
      .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'sessions'")
      .run(narrowed);
    rawNarrow.exec('PRAGMA writable_schema = OFF');
    rawNarrow.close();
    assertRecovery(() => new DroidexDatabase(narrowerPairs), narrowerPairs);
  });
});

test('opening the canonical database does not read or change Factory history files', () => {
  withTempDir((dir) => {
    const factoryPath = join(dir, 'session-index.sqlite');
    const payload = Buffer.from('fake-factory-history-bytes');
    writeFileSync(factoryPath, payload);
    const before = readFileSync(factoryPath);
    const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
    db.close();
    assert.deepEqual(readFileSync(factoryPath), before);
    const sources = [
      readFileSync(join(MODULE_DIR, 'DroidexDatabase.ts'), 'utf8'),
      readFileSync(join(MODULE_DIR, 'droidexSchema.ts'), 'utf8'),
      readFileSync(join(MODULE_DIR, '../droidexPaths.ts'), 'utf8'),
    ].join('\n');
    assert.equal(sources.includes('session-index.sqlite'), false);
    assert.equal(sources.includes('.factory/droidex'), false);
    assert.equal(sources.includes('~/.factory'), false);
  });
});

// Sentinels that must never become real provider vocabulary, so widening the
// union cannot turn this test's "not a member" assertions into false positives.
const SYNTHETIC_DRIVER = 'never-a-provider';
const SYNTHETIC_ACTION = 'open_never_a_provider_setup';

test('generated provider CHECK SQL tracks the TypeScript unions', () => {
  for (const id of providerInstanceIdSchema.options) {
    assert.ok(
      PROVIDER_PAIR_CHECK.includes(
        `(provider_driver_kind = '${id}' AND provider_instance_id = '${id}')`,
      ),
      id,
    );
  }
  for (const kind of providerDriverKindSchema.options) {
    assert.ok(PROVIDER_PAIR_CHECK.includes(`provider_driver_kind = '${kind}'`), kind);
  }
  for (const action of providerRecoveryActionSchema.options) {
    assert.ok(FAILURE_ACTION_CHECK.includes(`'${action}'`), action);
  }
  for (const code of providerErrorCodeSchema.options) {
    assert.ok(FAILURE_CODE_CHECK.includes(`'${code}'`), code);
  }

  const widenedPair = providerPairCheckSql(
    [...providerDriverKindSchema.options, SYNTHETIC_DRIVER],
    [...providerInstanceIdSchema.options, SYNTHETIC_DRIVER],
  );
  assert.ok(
    widenedPair.includes(
      `(provider_driver_kind = '${SYNTHETIC_DRIVER}' AND provider_instance_id = '${SYNTHETIC_DRIVER}')`,
    ),
  );
  assert.equal(PROVIDER_PAIR_CHECK.includes(SYNTHETIC_DRIVER), false);

  const widenedActions = sqlInList('failure_recovery_action', [
    ...providerRecoveryActionSchema.options,
    SYNTHETIC_ACTION,
  ]);
  assert.ok(widenedActions.includes(`'${SYNTHETIC_ACTION}'`));
  assert.equal(FAILURE_ACTION_CHECK.includes(SYNTHETIC_ACTION), false);

  assert.throws(() => providerPairCheckSql(['droid'], ["dro'id"]));
  assert.throws(() => providerPairCheckSql(['droid', 'codex'], ['droid']));
  assert.throws(() => sqlInList('failure_recovery_action', ["open_droid_setup'"]));
});

test('created tables embed the generated provider CHECK SQL', () => {
  withDb((db) => {
    const sessionsSql = schemaSql(db, 'table', 'sessions');
    assert.ok(sessionsSql.includes(normalizeSql(PROVIDER_PAIR_CHECK)));
    assert.ok(sessionsSql.includes(normalizeSql(FAILURE_ACTION_CHECK)));
    assert.ok(sessionsSql.includes(normalizeSql(FAILURE_CODE_CHECK)));
  });
});

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { droidexDatabasePath } from '../droidexPaths.js';
import { numberValue, stringValue } from '../values.js';
import {
  DROIDEX_SCHEMA_SQL,
  DROIDEX_SCHEMA_VERSION,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  EXPECTED_TRIGGERS,
  normalizeSql,
  type ExpectedForeignKey,
  type ExpectedIndex,
  type ExpectedTable,
} from './droidexSchema.js';

export { DROIDEX_SCHEMA_VERSION };

const RECOVERY = 'move or remove this file, then restart DROIDEX';

export class DroidexDatabase {
  private readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;
  private inTransaction = false;

  constructor(path = droidexDatabasePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.configureConnection();
      this.ensureSchema();
    } catch (error) {
      this.abandonOpen();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    if (this.inTransaction) {
      throw new Error('Nested DROIDEX database transactions are not supported.');
    }
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  prepare(sql: string): StatementSync {
    this.assertOpen();
    return this.db.prepare(sql);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private configureConnection(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  private ensureSchema(): void {
    const version = this.userVersion();
    const empty = this.isEmpty();
    if (empty && version === 0) {
      this.db.exec(DROIDEX_SCHEMA_SQL);
      this.db.exec(`PRAGMA user_version = ${String(DROIDEX_SCHEMA_VERSION)}`);
    } else if (version !== DROIDEX_SCHEMA_VERSION) {
      throw this.mismatch(`user_version ${String(version)}`);
    }
    this.assertExactSchema();
  }

  private isEmpty(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
        )
        .get() === undefined
    );
  }

  private userVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
    return numberValue(row?.user_version) ?? 0;
  }

  private assertExactSchema(): void {
    const version = this.userVersion();
    if (version !== DROIDEX_SCHEMA_VERSION) {
      throw this.mismatch(`user_version ${String(version)}`);
    }
    this.assertApplicationObjects();
    for (const table of EXPECTED_TABLES) this.assertTable(table);
    for (const index of EXPECTED_INDEXES) this.assertIndex(index);
    for (const trigger of EXPECTED_TRIGGERS) this.assertTrigger(trigger);
  }

  private assertApplicationObjects(): void {
    const objects = this.db
      .prepare(
        `
          SELECT type, name FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name
        `,
      )
      .all() as { type: unknown; name: unknown }[];
    const expected = [
      ...EXPECTED_INDEXES.map((index) => ({ type: 'index', name: index.name })),
      ...EXPECTED_TABLES.map((table) => ({ type: 'table', name: table.name })),
      ...EXPECTED_TRIGGERS.map((trigger) => ({ type: 'trigger', name: trigger.name })),
    ].sort((left, right) =>
      left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type.localeCompare(right.type),
    );
    const actual = objects.map((row) => ({
      type: stringValue(row.type) ?? '',
      name: stringValue(row.name) ?? '',
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw this.mismatch('application tables, indexes, or triggers differ');
    }
  }

  private assertTable(expected: ExpectedTable): void {
    const columns = this.pragmaRows(`table_info`, expected.name).map((row) => ({
      name: stringValue(row.name) ?? '',
      type: stringValue(row.type) ?? '',
      notnull: numberValue(row.notnull) ?? -1,
      pk: numberValue(row.pk) ?? -1,
    }));
    const wanted = expected.columns.map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      pk: column.pk,
    }));
    if (JSON.stringify(columns) !== JSON.stringify(wanted)) {
      throw this.mismatch(`table ${expected.name} columns`);
    }
    const foreignKeys = this.readForeignKeys(expected.name);
    const wantedKeys = [...expected.foreignKeys].map(foreignKeyKey).sort();
    const actualKeys = foreignKeys.map(foreignKeyKey).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys)) {
      throw this.mismatch(`table ${expected.name} foreign keys`);
    }
  }

  private assertIndex(expected: ExpectedIndex): void {
    const list = this.pragmaRows('index_list', expected.table);
    const row = list.find((entry) => stringValue(entry.name) === expected.name);
    if (!row) throw this.mismatch(`missing index ${expected.name}`);
    if (
      numberValue(row.unique) !== expected.unique ||
      numberValue(row.partial) !== expected.partial
    ) {
      throw this.mismatch(`index ${expected.name} flags`);
    }
    const columns = this.db.prepare(`PRAGMA index_info(${expected.name})`).all() as Record<
      string,
      unknown
    >[];
    const names = columns.map((column) => stringValue(column.name) ?? '');
    if (JSON.stringify(names) !== JSON.stringify(expected.columns)) {
      throw this.mismatch(`index ${expected.name} columns`);
    }
    const sql = this.schemaSql('index', expected.name);
    const where = /\bwhere\s+(.+)$/.exec(sql)?.[1] ?? null;
    if (where !== expected.where || sql !== normalizeSql(expected.sql)) {
      throw this.mismatch(`index ${expected.name} predicate`);
    }
  }

  private assertTrigger(expected: { name: string; sql: string }): void {
    const sql = this.schemaSql('trigger', expected.name);
    if (sql !== normalizeSql(expected.sql)) {
      throw this.mismatch(`trigger ${expected.name} SQL`);
    }
  }

  private readForeignKeys(table: string): ExpectedForeignKey[] {
    const rows = this.pragmaRows('foreign_key_list', table);
    const grouped = new Map<number, ExpectedForeignKey & { from: string[]; to: string[] }>();
    for (const row of rows) {
      const id = numberValue(row.id);
      const seq = numberValue(row.seq);
      if (id === undefined || seq === undefined) throw this.mismatch(`table ${table} foreign keys`);
      const current = grouped.get(id) ?? {
        table: stringValue(row.table) ?? '',
        from: [],
        to: [],
        onDelete: 'CASCADE',
      };
      if ((stringValue(row.on_delete) ?? '') !== 'CASCADE') {
        throw this.mismatch(`table ${table} foreign key delete action`);
      }
      current.from[seq] = stringValue(row.from) ?? '';
      current.to[seq] = stringValue(row.to) ?? '';
      grouped.set(id, current);
    }
    return [...grouped.values()];
  }

  private pragmaRows(pragma: 'table_info' | 'index_list' | 'foreign_key_list', table: string) {
    if (!/^[a-z_]+$/.test(table)) throw this.mismatch(`invalid identifier ${table}`);
    return this.db.prepare(`PRAGMA ${pragma}(${table})`).all() as Record<string, unknown>[];
  }

  private schemaSql(type: 'index' | 'trigger', name: string): string {
    const row = this.db
      .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
      .get(type, name) as Record<string, unknown> | undefined;
    const sql = stringValue(row?.sql);
    if (!sql) throw this.mismatch(`missing ${type} ${name}`);
    return normalizeSql(sql);
  }

  private mismatch(reason: string): Error {
    return new Error(
      `Canonical DROIDEX database at ${this.path} does not match schema version ${String(DROIDEX_SCHEMA_VERSION)} (${reason}); ${RECOVERY}.`,
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Canonical DROIDEX database at ${this.path} is closed.`);
  }

  private abandonOpen(): void {
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Preserve the initialization failure.
    }
  }
}

function foreignKeyKey(key: ExpectedForeignKey): string {
  return `${key.table}|${key.from.join(',')}|${key.to.join(',')}|${key.onDelete}`;
}

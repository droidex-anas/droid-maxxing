import { DatabaseSync } from 'node:sqlite';

import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
  HistoryWriterLease,
} from './historyPersistenceProtocol.js';
import { HistoryWriteStatements } from './historyWriteStatements.js';

export class HistoryPersistenceDatabase {
  private readonly db: DatabaseSync;
  private readonly writer: HistoryWriteStatements;
  private readonly readWriterLease;
  private readonly writeWriterLease;
  private readonly clearWriterLease;
  private claimedLease: HistoryWriterLease | null = null;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS events_compaction_summary
        ON events (app_session_id, source_session_id, id)
        WHERE kind = 'compaction' AND app_session_id IS NOT NULL
    `);
    this.writer = new HistoryWriteStatements(this.db);
    this.readWriterLease = this.db.prepare(`
      SELECT value_json
      FROM settings
      WHERE scope = 'history.persistence_writer_lease'
    `);
    this.writeWriterLease = this.db.prepare(`
      INSERT INTO settings (scope, value_json, updated_at)
      VALUES ('history.persistence_writer_lease', ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    this.clearWriterLease = this.db.prepare(`
      DELETE FROM settings
      WHERE scope = 'history.persistence_writer_lease' AND value_json = ?
    `);
  }

  persist(batch: HistoryPersistenceBatch, lease: HistoryWriterLease): HistoryPersistenceResult {
    const startedAt = performance.now();
    let eventsWritten = 0;
    let searchIdentityChanged = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.claimWriterLease(lease);
      for (const event of batch.events) eventsWritten += this.writer.writeEvent(event);
      for (const summary of batch.summaries) {
        searchIdentityChanged = this.writer.writeSummary(summary) || searchIdentityChanged;
      }
      if (searchIdentityChanged) this.writer.noteSearchIdentityChanges();
      for (const child of batch.children) this.writer.writeChild(child);
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      throw error;
    }
    return {
      durationMs: performance.now() - startedAt,
      eventsWritten,
      summariesWritten: batch.summaries.length,
      childrenWritten: batch.children.length,
    };
  }

  durabilityBarrier(lease: HistoryWriterLease): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.claimWriterLease(lease);
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      throw error;
    }
    this.db.exec('PRAGMA synchronous = FULL');
    try {
      const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(FULL)').get() as
        | { busy?: unknown }
        | undefined;
      if (Number(checkpoint?.busy ?? 1) !== 0) {
        throw new Error('History durability checkpoint remained busy.');
      }
    } finally {
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
  }

  close(): void {
    if (this.claimedLease) {
      this.clearWriterLease.run(JSON.stringify(this.claimedLease));
      this.claimedLease = null;
    }
    this.db.close();
  }

  private claimWriterLease(lease: HistoryWriterLease): void {
    const current = this.readWriterLease.get() as { value_json: unknown } | undefined;
    const currentLease = parseWriterLease(current?.value_json);
    if (current && !currentLease) {
      throw new Error('History persistence writer lease is invalid; rebuild the history database.');
    }
    if (currentLease) {
      if (currentLease.owner !== lease.owner && isProcessAlive(currentLease.processId)) {
        throw new Error('History persistence writer lease is owned by another live worker.');
      }
      if (currentLease.owner === lease.owner && currentLease.generation > lease.generation) {
        throw new Error(
          `History persistence writer generation ${String(lease.generation)} was replaced by generation ${String(currentLease.generation)}.`,
        );
      }
    }
    this.writeWriterLease.run(JSON.stringify(lease), Date.now());
    this.claimedLease = lease;
  }
}

function parseWriterLease(value: unknown): HistoryWriterLease | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('owner' in parsed) ||
      !('generation' in parsed) ||
      !('processId' in parsed)
    ) {
      return null;
    }
    const { owner, generation, processId } = parsed;
    if (typeof owner !== 'string' || owner.length === 0) return null;
    if (!isPositiveSafeInteger(generation)) return null;
    if (!isPositiveSafeInteger(processId)) return null;
    return {
      owner,
      generation,
      processId,
    };
  } catch {
    return null;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the original SQLite failure.
  }
}

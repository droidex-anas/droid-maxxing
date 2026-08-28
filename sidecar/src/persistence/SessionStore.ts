import type { StatementSync } from 'node:sqlite';

import type { ChildSessionSummary, SessionSummary } from '../protocol.js';
import { parseProviderError, type ProviderError } from '../providers/providerErrors.js';
import {
  providerDriverKindForInstance,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from '../providers/providerIdentity.js';
import type { DroidexDatabase } from './DroidexDatabase.js';
import {
  decodeStoredChild,
  decodeStoredSession,
  encodeChildSummaryJson,
} from './sessionRowCodec.js';
import {
  decodeSummaryJson,
  encodePreviousProviderSessionIds,
  encodeResumeState,
  encodeSummaryJson,
  mergeSummaryJson,
  requireText,
  type SummaryJson,
} from './sessionSummaryJson.js';

export const CANONICAL_RESET_RECOVERY = 'move or remove this file, then restart DROIDEX';

export type SessionLifecycleStatus = 'initializing' | 'running' | 'paused' | 'completed' | 'failed';

export interface ProviderBinding {
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  providerSessionId?: string;
  previousProviderSessionIds: string[];
  resumeState?: unknown;
  runtimeGeneration: number;
}

export interface StoredSession {
  summary: SessionSummary;
  binding: ProviderBinding;
  lifecycleStatus: SessionLifecycleStatus;
  failure?: ProviderError;
  hidden: boolean;
}

export interface StoredChildSession {
  summary: ChildSessionSummary;
  binding: ProviderBinding;
  lifecycleStatus: SessionLifecycleStatus;
}

export interface CreateProvisionalInput {
  appSessionId: string;
  clientRef: string;
  summary: SessionSummary;
}

export interface UpsertChildInput {
  parentAppSessionId: string;
  childSessionId: string;
  summary: ChildSessionSummary;
  binding: Pick<ProviderBinding, 'providerDriverKind' | 'providerInstanceId'> &
    Partial<Pick<ProviderBinding, 'providerSessionId' | 'resumeState'>>;
}

export class SessionStore {
  private readonly insertSession: StatementSync;
  private readonly selectByAppId: StatementSync;
  private readonly selectByClientRef: StatementSync;
  private readonly selectVisible: StatementSync;
  private readonly updateLifecycle: StatementSync;
  private readonly updateFailed: StatementSync;
  private readonly updateSummaryStatement: StatementSync;
  private readonly bindInitialStatement: StatementSync;
  private readonly updateResumeStatement: StatementSync;
  private readonly replaceRuntimeStatement: StatementSync;
  private readonly updateHidden: StatementSync;
  private readonly upsertChildStatement: StatementSync;
  private readonly selectChild: StatementSync;
  private readonly selectChildren: StatementSync;

  constructor(private readonly db: DroidexDatabase) {
    this.insertSession = db.prepare(`
      INSERT INTO sessions (
        app_session_id, client_ref, provider_driver_kind, provider_instance_id,
        provider_session_id, previous_provider_session_ids_json, resume_state_json,
        runtime_generation, summary_json, lifecycle_status, failure_code, failure_message,
        failure_recovery_action, hidden, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, '[]', NULL, 0, ?, 'initializing', NULL, NULL, NULL, 0, ?, ?)
    `);
    this.selectByAppId = db.prepare('SELECT * FROM sessions WHERE app_session_id = ?');
    this.selectByClientRef = db.prepare('SELECT * FROM sessions WHERE client_ref = ?');
    this.selectVisible = db.prepare(`
      SELECT * FROM sessions WHERE hidden = 0
      ORDER BY updated_at DESC, app_session_id DESC
    `);
    this.updateLifecycle = db.prepare(`
      UPDATE sessions
      SET lifecycle_status = ?, failure_code = NULL, failure_message = NULL,
          failure_recovery_action = NULL, updated_at = ?
      WHERE app_session_id = ?
    `);
    this.updateFailed = db.prepare(`
      UPDATE sessions
      SET lifecycle_status = 'failed', failure_code = ?, failure_message = ?,
          failure_recovery_action = ?, updated_at = ?
      WHERE app_session_id = ?
    `);
    this.updateSummaryStatement = db.prepare(`
      UPDATE sessions SET summary_json = ?, updated_at = ? WHERE app_session_id = ?
    `);
    this.bindInitialStatement = db.prepare(`
      UPDATE sessions
      SET provider_session_id = ?, resume_state_json = ?, runtime_generation = runtime_generation + 1
      WHERE app_session_id = ? AND runtime_generation = ? AND provider_session_id IS NULL
    `);
    this.updateResumeStatement = db.prepare(`
      UPDATE sessions SET resume_state_json = ?
      WHERE app_session_id = ? AND runtime_generation = ?
    `);
    this.replaceRuntimeStatement = db.prepare(`
      UPDATE sessions
      SET provider_session_id = ?, previous_provider_session_ids_json = ?,
          resume_state_json = ?, runtime_generation = runtime_generation + 1
      WHERE app_session_id = ? AND runtime_generation = ?
    `);
    this.updateHidden = db.prepare(`
      UPDATE sessions SET hidden = ?, updated_at = ? WHERE app_session_id = ?
    `);
    this.upsertChildStatement = db.prepare(`
      INSERT INTO child_sessions (
        parent_app_session_id, child_session_id, provider_driver_kind, provider_instance_id,
        provider_session_id, previous_provider_session_ids_json, resume_state_json,
        runtime_generation, summary_json, lifecycle_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '[]', ?, 0, ?, 'running', ?, ?)
      ON CONFLICT (parent_app_session_id, child_session_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        resume_state_json = excluded.resume_state_json,
        summary_json = excluded.summary_json,
        lifecycle_status = excluded.lifecycle_status,
        updated_at = excluded.updated_at
    `);
    this.selectChild = db.prepare(`
      SELECT * FROM child_sessions
      WHERE parent_app_session_id = ? AND child_session_id = ?
    `);
    this.selectChildren = db.prepare(`
      SELECT * FROM child_sessions
      WHERE parent_app_session_id = ?
      ORDER BY updated_at DESC, child_session_id DESC
    `);
  }

  createProvisional(input: CreateProvisionalInput, now = Date.now()): StoredSession {
    const instanceId = input.summary.configuration.providerSelection.providerInstanceId;
    const driverKind = providerDriverKindForInstance(instanceId);
    if (input.summary.appSessionId !== input.appSessionId) {
      throw new Error('Provisional summary appSessionId must match the session identity.');
    }
    const summaryJson = encodeSummaryJson(input.summary);
    decodeSummaryJson(summaryJson, instanceId);
    return this.db.atomic(() => {
      try {
        this.insertSession.run(
          input.appSessionId,
          input.clientRef,
          driverKind,
          instanceId,
          summaryJson,
          now,
          now,
        );
      } catch (error) {
        throw this.insertConflict(error, input);
      }
      return this.requireSession(input.appSessionId);
    });
  }

  findByClientRef(clientRef: string): StoredSession | undefined {
    return this.readSession(this.selectByClientRef.get(clientRef));
  }

  get(appSessionId: string): StoredSession | undefined {
    return this.readSession(this.selectByAppId.get(appSessionId));
  }

  list(): StoredSession[] {
    return this.selectVisible.all().map((row) => this.requireDecoded(row));
  }

  markStarted(appSessionId: string, now = Date.now()): StoredSession {
    return this.db.atomic(() => {
      this.requireSession(appSessionId);
      this.updateLifecycle.run('running', now, appSessionId);
      return this.requireSession(appSessionId);
    });
  }

  markFailed(appSessionId: string, error: ProviderError, now = Date.now()): StoredSession {
    const parsed = parseProviderError(error);
    return this.db.atomic(() => {
      const current = this.requireSession(appSessionId);
      if (parsed.providerInstanceId !== current.binding.providerInstanceId) {
        throw new Error(
          `Failure instance ${parsed.providerInstanceId} does not match session ${appSessionId} instance ${current.binding.providerInstanceId}.`,
        );
      }
      this.updateFailed.run(parsed.code, parsed.message, parsed.recoveryAction, now, appSessionId);
      return this.requireSession(appSessionId);
    });
  }

  updateSummary(
    appSessionId: string,
    patch: Partial<SummaryJson>,
    options: { touchActivity?: boolean; now?: number } = {},
  ): StoredSession {
    return this.db.atomic(() => {
      const current = this.requireSession(appSessionId);
      if (patch.configuration) {
        const nextInstance = patch.configuration.providerSelection.providerInstanceId;
        if (nextInstance !== current.binding.providerInstanceId) {
          throw new Error('SessionStore cannot change the nested provider instance.');
        }
      }
      const json = decodeSummaryJson(
        encodeSummaryJson(current.summary),
        current.binding.providerInstanceId,
      );
      const merged = mergeSummaryJson(json, patch);
      const now = options.now ?? Date.now();
      const updatedAt = options.touchActivity === false ? current.summary.updatedAt : now;
      this.updateSummaryStatement.run(JSON.stringify(merged), updatedAt, appSessionId);
      return this.requireSession(appSessionId);
    });
  }

  bindInitialProviderRuntime(
    appSessionId: string,
    expectedGeneration: number,
    providerSessionId: string,
    resumeState?: unknown,
  ): StoredSession {
    requireText(providerSessionId, 'providerSessionId');
    const resumeJson = encodeResumeState(resumeState);
    return this.db.atomic(() => {
      const current = this.requireSession(appSessionId);
      if (current.binding.runtimeGeneration !== expectedGeneration) {
        throw staleGenerationError(
          appSessionId,
          current.binding.runtimeGeneration,
          expectedGeneration,
        );
      }
      if (current.binding.providerSessionId) {
        throw new Error(`Session ${appSessionId} already has an initial provider runtime.`);
      }
      const result = this.bindInitialStatement.run(
        providerSessionId,
        resumeJson,
        appSessionId,
        expectedGeneration,
      );
      if (result.changes !== 1) {
        throw staleGenerationError(
          appSessionId,
          current.binding.runtimeGeneration,
          expectedGeneration,
        );
      }
      return this.requireSession(appSessionId);
    });
  }

  updateResumeState(
    appSessionId: string,
    expectedGeneration: number,
    resumeState: unknown,
  ): StoredSession {
    const resumeJson = encodeResumeState(resumeState);
    return this.db.atomic(() => {
      const current = this.requireSession(appSessionId);
      const result = this.updateResumeStatement.run(resumeJson, appSessionId, expectedGeneration);
      if (result.changes !== 1) {
        throw staleGenerationError(
          appSessionId,
          current.binding.runtimeGeneration,
          expectedGeneration,
        );
      }
      const updated = this.requireSession(appSessionId);
      if (updated.binding.runtimeGeneration !== expectedGeneration) {
        throw new Error(`Resume-state update changed generation for ${appSessionId}.`);
      }
      return updated;
    });
  }

  replaceProviderRuntime(
    appSessionId: string,
    expectedGeneration: number,
    providerSessionId: string,
    resumeState?: unknown,
  ): StoredSession {
    requireText(providerSessionId, 'providerSessionId');
    const resumeJson = encodeResumeState(resumeState);
    return this.db.atomic(() => {
      const current = this.requireSession(appSessionId);
      const previous = [...current.binding.previousProviderSessionIds];
      if (
        current.binding.providerSessionId &&
        current.binding.providerSessionId !== providerSessionId
      ) {
        previous.push(current.binding.providerSessionId);
      }
      const result = this.replaceRuntimeStatement.run(
        providerSessionId,
        encodePreviousProviderSessionIds(previous),
        resumeJson,
        appSessionId,
        expectedGeneration,
      );
      if (result.changes !== 1) {
        throw staleGenerationError(
          appSessionId,
          current.binding.runtimeGeneration,
          expectedGeneration,
        );
      }
      return this.requireSession(appSessionId);
    });
  }

  setHidden(appSessionId: string, hidden: boolean, now = Date.now()): StoredSession {
    return this.db.atomic(() => {
      this.requireSession(appSessionId);
      this.updateHidden.run(hidden ? 1 : 0, now, appSessionId);
      return this.requireSession(appSessionId);
    });
  }

  upsertChild(input: UpsertChildInput, now = Date.now()): StoredChildSession {
    const summaryJson = encodeChildSummaryJson(input.summary);
    return this.db.atomic(() => {
      this.requireSession(input.parentAppSessionId);
      this.upsertChildStatement.run(
        input.parentAppSessionId,
        input.childSessionId,
        input.binding.providerDriverKind,
        input.binding.providerInstanceId,
        input.binding.providerSessionId ?? null,
        encodeResumeState(input.binding.resumeState),
        summaryJson,
        now,
        now,
      );
      return this.requireChild(input.parentAppSessionId, input.childSessionId);
    });
  }

  getChild(parentAppSessionId: string, childSessionId: string): StoredChildSession | undefined {
    return this.readChild(this.selectChild.get(parentAppSessionId, childSessionId));
  }

  listChildren(parentAppSessionId: string): StoredChildSession[] {
    return this.selectChildren.all(parentAppSessionId).map((row) => this.requireDecodedChild(row));
  }

  private requireSession(appSessionId: string): StoredSession {
    const stored = this.get(appSessionId);
    if (!stored) throw new Error(`Session ${appSessionId} is not in the canonical store.`);
    return stored;
  }

  private requireChild(parentAppSessionId: string, childSessionId: string): StoredChildSession {
    const stored = this.getChild(parentAppSessionId, childSessionId);
    if (!stored) {
      throw new Error(
        `Child ${parentAppSessionId}/${childSessionId} is not in the canonical store.`,
      );
    }
    return stored;
  }

  private readSession(row: unknown): StoredSession | undefined {
    if (row === undefined) return undefined;
    return this.requireDecoded(row);
  }

  private readChild(row: unknown): StoredChildSession | undefined {
    if (row === undefined) return undefined;
    return this.requireDecodedChild(row);
  }

  private requireDecoded(row: unknown): StoredSession {
    try {
      return decodeStoredSession(row);
    } catch (error) {
      throw this.corrupt('sessions', error);
    }
  }

  private requireDecodedChild(row: unknown): StoredChildSession {
    try {
      return decodeStoredChild(row);
    } catch (error) {
      throw this.corrupt('child_sessions', error);
    }
  }

  private insertConflict(error: unknown, input: CreateProvisionalInput): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: sessions.app_session_id/i.test(message)) {
      return new Error(`Session ${input.appSessionId} already exists.`);
    }
    if (/UNIQUE constraint failed: sessions.client_ref/i.test(message)) {
      return new Error(`clientRef ${input.clientRef} already exists.`);
    }
    return error instanceof Error ? error : new Error(message);
  }

  private corrupt(table: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(
      `Canonical DROIDEX database at ${this.db.databasePath} has a corrupt ${table} row (${detail}); ${CANONICAL_RESET_RECOVERY}.`,
    );
  }
}

function staleGenerationError(appSessionId: string, actual: number, expected: number): Error {
  return new Error(
    `Session ${appSessionId} binding generation ${String(actual)} does not match expected ${String(expected)}.`,
  );
}

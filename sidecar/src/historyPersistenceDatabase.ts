import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { PersistedChildSession } from './history.js';
import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
  PersistedEventMetadata,
} from './historyPersistenceProtocol.js';
import type { SessionSearchResult, SessionSummary } from './protocol.js';
import {
  resetSessionSearchCache,
  searchSessionFiles,
  type SessionSearchCandidate,
} from './sessionSearch.js';

export class HistoryPersistenceDatabase {
  private readonly db: DatabaseSync;
  private readonly insertEvent: StatementSync;
  private readonly upsertSummary: StatementSync;
  private readonly upsertChild: StatementSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, source_session_id, app_session_id, kind, ts)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.upsertSummary = this.db.prepare(`
      INSERT INTO app_sessions (
        app_session_id,
        provider_session_id,
        compacted_from_provider_session_ids,
        session_purpose,
        interaction_mode,
        title,
        cwd,
        workspace_kind,
        updated_at,
        model_id,
        reasoning_effort,
        compaction_model,
        worker_model_id,
        worker_reasoning_effort,
        validator_model_id,
        validator_reasoning_effort,
        autonomy,
        tokens_in,
        tokens_out,
        context_tokens,
        context_remaining_tokens,
        context_accuracy,
        context_updated_at,
        max_context_tokens,
        auto_compactions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_session_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        compacted_from_provider_session_ids = excluded.compacted_from_provider_session_ids,
        session_purpose = excluded.session_purpose,
        interaction_mode = excluded.interaction_mode,
        title = excluded.title,
        cwd = excluded.cwd,
        workspace_kind = excluded.workspace_kind,
        updated_at = excluded.updated_at,
        model_id = excluded.model_id,
        reasoning_effort = excluded.reasoning_effort,
        compaction_model = excluded.compaction_model,
        worker_model_id = excluded.worker_model_id,
        worker_reasoning_effort = excluded.worker_reasoning_effort,
        validator_model_id = excluded.validator_model_id,
        validator_reasoning_effort = excluded.validator_reasoning_effort,
        autonomy = excluded.autonomy,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        context_tokens = excluded.context_tokens,
        context_remaining_tokens = excluded.context_remaining_tokens,
        context_accuracy = excluded.context_accuracy,
        context_updated_at = excluded.context_updated_at,
        max_context_tokens = excluded.max_context_tokens,
        auto_compactions = excluded.auto_compactions
    `);
    this.upsertChild = this.db.prepare(`
      INSERT INTO child_sessions (
        parent_app_session_id,
        child_session_id,
        provider_session_id,
        previous_provider_session_ids,
        role,
        label,
        prompt,
        status,
        model_id,
        reasoning_effort,
        spawn_link_kind,
        spawn_link_id,
        transcript_available,
        started_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent_app_session_id, child_session_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        previous_provider_session_ids = excluded.previous_provider_session_ids,
        role = excluded.role,
        label = excluded.label,
        prompt = excluded.prompt,
        status = excluded.status,
        model_id = excluded.model_id,
        reasoning_effort = excluded.reasoning_effort,
        spawn_link_kind = excluded.spawn_link_kind,
        spawn_link_id = excluded.spawn_link_id,
        transcript_available = excluded.transcript_available,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `);
  }

  persist(batch: HistoryPersistenceBatch): HistoryPersistenceResult {
    const startedAt = performance.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of batch.events) this.writeEvent(event);
      for (const summary of batch.summaries) this.writeSummary(summary);
      for (const child of batch.children) this.writeChild(child);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Keep the original database error; the worker will be discarded if
        // SQLite cannot complete rollback cleanly.
      }
      throw error;
    }
    return {
      durationMs: performance.now() - startedAt,
      eventsWritten: batch.events.length,
      summariesWritten: batch.summaries.length,
      childrenWritten: batch.children.length,
    };
  }

  async search(
    query: string,
    candidates: SessionSearchCandidate[],
    isStale: () => boolean,
  ): Promise<SessionSearchResult[]> {
    return await searchSessionFiles(candidates, query, isStale);
  }

  invalidateSearch(): void {
    resetSessionSearchCache();
  }

  close(): void {
    resetSessionSearchCache();
    this.db.close();
  }

  private writeEvent(event: PersistedEventMetadata): void {
    this.insertEvent.run(event.id, event.sourceSessionId, event.appSessionId, event.kind, event.ts);
  }

  private writeSummary(summary: SessionSummary): void {
    this.upsertSummary.run(
      summary.appSessionId,
      summary.providerSessionId ?? summary.appSessionId,
      JSON.stringify(summary.compactedFromProviderSessionIds ?? []),
      summary.sessionPurpose,
      summary.interactionMode,
      summary.title,
      sqlValue(summary.cwd),
      sqlValue(summary.workspaceKind),
      summary.updatedAt,
      sqlValue(summary.modelId),
      sqlValue(summary.reasoningEffort),
      sqlValue(summary.compactionModel),
      sqlValue(summary.workerModelId),
      sqlValue(summary.workerReasoningEffort),
      sqlValue(summary.validatorModelId),
      sqlValue(summary.validatorReasoningEffort),
      sqlValue(summary.autonomy),
      summary.tokensIn,
      summary.tokensOut,
      summary.contextTokens,
      sqlValue(summary.contextRemainingTokens),
      sqlValue(summary.contextAccuracy),
      sqlValue(summary.contextUpdatedAt),
      sqlValue(summary.maxContextTokens),
      sqlValue(summary.autoCompactions),
    );
  }

  private writeChild(child: PersistedChildSession): void {
    this.upsertChild.run(
      child.parentAppSessionId,
      child.childSessionId,
      sqlValue(child.providerSessionId),
      JSON.stringify(child.previousProviderSessionIds ?? []),
      child.role,
      sqlValue(child.label),
      sqlValue(child.prompt),
      child.status,
      child.modelId,
      sqlValue(child.reasoningEffort),
      sqlValue(child.spawnLink?.kind),
      sqlValue(child.spawnLink?.id),
      child.transcriptAvailable ? 1 : 0,
      sqlValue(child.startedAt),
      child.updatedAt,
    );
  }
}

function sqlValue(value: string | number | undefined): string | number | null {
  return value ?? null;
}

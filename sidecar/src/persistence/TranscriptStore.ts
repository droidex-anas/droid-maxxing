import type { StatementSync } from 'node:sqlite';

import type { SessionSearchMatch, SessionSearchResult } from '../protocol.js';
import type { SessionTarget } from '../providers/providerIdentity.js';
import { buildSessionSearchSnippet } from '../sessionSearch.js';
import {
  canonicalPayloadJson,
  childSessionId,
  envelopesAreByteEquivalent,
  parentAppSessionId,
  parseCanonicalEvent,
  parseCanonicalEventPayload,
  searchAuthorForPayload,
  searchTextForPayload,
  type CanonicalEvent,
  type PersistedCanonicalEvent,
} from '../sessionEvents.js';
import { numberValue, stringValue } from '../values.js';
import type { DroidexDatabase } from './DroidexDatabase.js';

export const DEFAULT_PAGE_LIMIT = 400;
export const MAX_PAGE_LIMIT = 1_600;
export const MAX_SEARCH_SESSIONS = 150;
export const MAX_SEARCH_TEXT_BYTES = 40_000_000;
export const MAX_SEARCH_SESSION_RESULTS = 25;
export const MAX_SEARCH_SNIPPETS_PER_SESSION = 3;
export const DEFAULT_SEARCH_BATCH_SIZE = 256;

export interface TranscriptPage {
  events: PersistedCanonicalEvent[];
  olderCursor?: string;
}

export interface PersistedTurnStart {
  turnId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  startedAt: string;
}

export interface PersistedTurnSettlement {
  runtimeGeneration: number;
  status: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  settledAt: string;
  providerTurnId?: string;
}

export interface TranscriptStoreOptions {
  yieldToEventLoop?: () => Promise<void>;
  searchBatchSize?: number;
  maxSearchSessions?: number;
  maxSearchTextBytes?: number;
  maxSearchResults?: number;
  maxSnippetsPerSession?: number;
}

export class CanonicalEventCollisionError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Canonical event ${eventId} already exists with a different envelope or payload.`);
    this.name = 'CanonicalEventCollisionError';
    this.eventId = eventId;
  }
}

export class InvalidTranscriptCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid transcript page cursor ${cursor}.`);
    this.name = 'InvalidTranscriptCursorError';
  }
}

const OPEN_TURN_STATUSES = new Set(['pending', 'running']);
const SETTLED_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

export class TranscriptStore {
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly searchBatchSize: number;
  private readonly maxSearchSessions: number;
  private readonly maxSearchTextBytes: number;
  private readonly maxSearchResults: number;
  private readonly maxSnippetsPerSession: number;
  private readonly selectByEventId: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly pageSession: StatementSync;
  private readonly pageChild: StatementSync;
  private readonly recentSessions: StatementSync;
  private readonly searchBatch: StatementSync;
  private readonly insertTurn: StatementSync;
  private readonly selectTurn: StatementSync;
  private readonly settleTurnStatement: StatementSync;

  constructor(
    private readonly db: DroidexDatabase,
    options: TranscriptStoreOptions = {},
  ) {
    this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
    this.searchBatchSize = options.searchBatchSize ?? DEFAULT_SEARCH_BATCH_SIZE;
    this.maxSearchSessions = options.maxSearchSessions ?? MAX_SEARCH_SESSIONS;
    this.maxSearchTextBytes = options.maxSearchTextBytes ?? MAX_SEARCH_TEXT_BYTES;
    this.maxSearchResults = options.maxSearchResults ?? MAX_SEARCH_SESSION_RESULTS;
    this.maxSnippetsPerSession = options.maxSnippetsPerSession ?? MAX_SEARCH_SNIPPETS_PER_SESSION;
    this.selectByEventId = db.prepare('SELECT * FROM transcript_events WHERE event_id = ?');
    this.insertEvent = db.prepare(`
      INSERT INTO transcript_events (
        event_id, parent_app_session_id, target_kind, child_session_id, turn_id,
        runtime_generation, provider_driver_kind, provider_instance_id, provider_session_id,
        provider_turn_id, provider_item_id, payload_json, search_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Pages are ordered by event_order, not created_at, so equal timestamps stay stable.
    this.pageSession = db.prepare(`
      SELECT * FROM transcript_events
      WHERE parent_app_session_id = ?
        AND child_session_id IS NULL
        AND event_order < ?
      ORDER BY event_order DESC
      LIMIT ?
    `);
    this.pageChild = db.prepare(`
      SELECT * FROM transcript_events
      WHERE parent_app_session_id = ?
        AND child_session_id = ?
        AND event_order < ?
      ORDER BY event_order DESC
      LIMIT ?
    `);
    this.recentSessions = db.prepare(`
      SELECT parent_app_session_id AS app_session_id, MAX(event_order) AS latest
      FROM transcript_events
      GROUP BY parent_app_session_id
      ORDER BY latest DESC, parent_app_session_id
      LIMIT ?
    `);
    this.searchBatch = db.prepare(`
      SELECT event_order, parent_app_session_id, created_at, search_text, payload_json
      FROM transcript_events
      WHERE child_session_id IS NULL
        AND length(search_text) > 0
        AND event_order < ?
        AND parent_app_session_id IN (SELECT value FROM json_each(?))
      ORDER BY event_order DESC
      LIMIT ?
    `);
    this.insertTurn = db.prepare(`
      INSERT INTO turns (
        turn_id, parent_app_session_id, target_kind, child_session_id, runtime_generation,
        lifecycle_status, provider_turn_id, started_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL)
    `);
    this.selectTurn = db.prepare('SELECT * FROM turns WHERE turn_id = ?');
    this.settleTurnStatement = db.prepare(`
      UPDATE turns
      SET lifecycle_status = ?, provider_turn_id = ?, settled_at = ?
      WHERE turn_id = ?
    `);
  }

  beginTurn(input: PersistedTurnStart): void {
    this.db.atomic(() => {
      const startedAt = parseStoredTimestamp(input.startedAt, 'startedAt');
      if (input.runtimeGeneration < 0 || !Number.isSafeInteger(input.runtimeGeneration)) {
        throw new Error('Turn runtimeGeneration must be a nonnegative integer.');
      }
      try {
        this.insertTurn.run(
          input.turnId,
          parentAppSessionId(input.target),
          input.target.kind,
          childSessionId(input.target) ?? null,
          input.runtimeGeneration,
          startedAt,
        );
      } catch (error) {
        throw turnInsertError(input.turnId, error);
      }
    });
  }

  settleTurn(turnId: string, settlement: PersistedTurnSettlement): void {
    this.db.atomic(() => {
      const row = this.selectTurn.get(turnId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Turn ${turnId} does not exist.`);
      const status = stringValue(row.lifecycle_status);
      if (status === undefined || !OPEN_TURN_STATUSES.has(status)) {
        throw new Error(
          `Turn ${turnId} cannot settle from ${status ?? 'unknown'} to ${settlement.status}.`,
        );
      }
      const generation = sqlInteger(row.runtime_generation, 'runtime_generation');
      if (generation !== settlement.runtimeGeneration) {
        throw new Error(
          `Turn ${turnId} generation ${String(generation)} does not match settlement generation ${String(settlement.runtimeGeneration)}.`,
        );
      }
      if (!SETTLED_TURN_STATUSES.has(settlement.status)) {
        throw new Error(`Invalid turn settlement status ${settlement.status}.`);
      }
      this.settleTurnStatement.run(
        settlement.status,
        settlement.providerTurnId ?? null,
        parseStoredTimestamp(settlement.settledAt, 'settledAt'),
        turnId,
      );
    });
  }

  append(event: CanonicalEvent): PersistedCanonicalEvent {
    return this.db.atomic(() => this.appendOne(event));
  }

  appendMany(events: readonly CanonicalEvent[]): PersistedCanonicalEvent[] {
    return this.db.atomic(() => events.map((event) => this.appendOne(event)));
  }

  page(input: SessionTarget & { before?: string; limit?: number }): TranscriptPage {
    const limit = clampPageLimit(input.limit);
    const before =
      input.before === undefined ? Number.MAX_SAFE_INTEGER : parsePageCursor(input.before);
    const rows =
      input.kind === 'session'
        ? this.pageSession.all(input.appSessionId, before, limit)
        : this.pageChild.all(input.parentAppSessionId, input.childSessionId, before, limit);
    const chronological = (rows as Record<string, unknown>[])
      .map((row) => this.rowToPersisted(row))
      .reverse();
    const page: TranscriptPage = { events: chronological };
    if (chronological.length === limit) {
      const oldest = chronological[0];
      if (oldest !== undefined) page.olderCursor = String(oldest.seq);
    }
    return page;
  }

  async search(query: string, isStale?: () => boolean): Promise<SessionSearchResult[]> {
    const queryLower = query.trim().toLowerCase();
    if (queryLower.length === 0) return [];
    const sessionIds = this.recentSessionIds();
    if (sessionIds.length === 0) return [];
    const grouped = new Map<string, SessionSearchMatch[]>();
    let chargedBytes = 0;
    let beforeOrder = Number.MAX_SAFE_INTEGER;
    for (;;) {
      if (isStale?.()) return [];
      // Bounded event_order batches keep the 40 MB budget off the event loop;
      // isStale is checked around each .all(), then we yield before the next.
      const batch = this.searchBatch.all(
        beforeOrder,
        JSON.stringify(sessionIds),
        this.searchBatchSize,
      ) as Record<string, unknown>[];
      if (isStale?.()) return [];
      if (batch.length === 0) break;
      const exhausted = this.consumeSearchBatch(batch, queryLower, grouped, chargedBytes);
      chargedBytes = exhausted.chargedBytes;
      if (exhausted.stop) break;
      const last = batch[batch.length - 1];
      beforeOrder = last === undefined ? 0 : sqlInteger(last.event_order, 'event_order');
      if (batch.length < this.searchBatchSize) break;
      await this.yieldToEventLoop();
    }
    return [...grouped.entries()].map(([appSessionId, matches]) => ({ appSessionId, matches }));
  }

  private recentSessionIds(): string[] {
    const rows = this.recentSessions.all(this.maxSearchSessions) as Record<string, unknown>[];
    const ids: string[] = [];
    for (const row of rows) {
      const id = stringValue(row.app_session_id);
      if (id) ids.push(id);
    }
    return ids;
  }

  private consumeSearchBatch(
    batch: Record<string, unknown>[],
    queryLower: string,
    grouped: Map<string, SessionSearchMatch[]>,
    chargedBytes: number,
  ): { chargedBytes: number; stop: boolean } {
    let charged = chargedBytes;
    for (const row of batch) {
      const text = stringValue(row.search_text) ?? '';
      const bytes = Buffer.byteLength(text, 'utf8');
      if (charged + bytes > this.maxSearchTextBytes) return { chargedBytes: charged, stop: true };
      charged += bytes;
      const appSessionId = stringValue(row.parent_app_session_id);
      if (!appSessionId || !text.toLowerCase().includes(queryLower)) continue;
      const existing = grouped.get(appSessionId);
      if (existing === undefined && grouped.size >= this.maxSearchResults) continue;
      if (existing !== undefined && existing.length >= this.maxSnippetsPerSession) continue;
      const payloadJson = stringValue(row.payload_json);
      const payload = parseCanonicalEventPayload(parseJson(payloadJson ?? 'null'));
      const author = searchAuthorForPayload(payload);
      const ts = sqlInteger(row.created_at, 'created_at');
      if (author === undefined) continue;
      const snippet = buildSessionSearchSnippet(text, queryLower);
      if (snippet === null) continue;
      const matches = existing ?? [];
      matches.push({ snippet, author, ts });
      grouped.set(appSessionId, matches);
    }
    const complete =
      grouped.size >= this.maxSearchResults &&
      [...grouped.values()].every((matches) => matches.length >= this.maxSnippetsPerSession);
    return { chargedBytes: charged, stop: complete };
  }

  private appendOne(event: CanonicalEvent): PersistedCanonicalEvent {
    const canonical = parseCanonicalEvent(event);
    const existing = this.selectByEventId.get(canonical.eventId) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      const persisted = this.rowToPersisted(existing);
      // Exact replay is idempotent; any other field difference is a collision that
      // must roll back rather than allocate a new event_order.
      if (envelopesAreByteEquivalent(persisted, canonical)) return persisted;
      throw new CanonicalEventCollisionError(canonical.eventId);
    }
    const native = canonical.nativeCorrelation;
    this.insertEvent.run(
      canonical.eventId,
      parentAppSessionId(canonical.target),
      canonical.target.kind,
      childSessionId(canonical.target) ?? null,
      canonical.turnId ?? null,
      canonical.runtimeGeneration,
      canonical.providerDriverKind,
      canonical.providerInstanceId,
      native?.sessionId ?? null,
      native?.turnId ?? null,
      native?.itemId ?? null,
      canonicalPayloadJson(canonical.payload),
      searchTextForPayload(canonical.payload),
      canonical.createdAt,
    );
    const inserted = this.selectByEventId.get(canonical.eventId) as
      | Record<string, unknown>
      | undefined;
    if (!inserted) throw new Error(`Failed to persist canonical event ${canonical.eventId}.`);
    return this.rowToPersisted(inserted);
  }

  private rowToPersisted(row: Record<string, unknown>): PersistedCanonicalEvent {
    const payloadJson = stringValue(row.payload_json);
    if (!payloadJson) throw new Error('Canonical transcript row is missing payload_json.');
    const eventId = requiredString(row.event_id, 'event_id');
    const parent = requiredString(row.parent_app_session_id, 'parent_app_session_id');
    const targetKind = requiredString(row.target_kind, 'target_kind');
    const child = stringValue(row.child_session_id);
    const target: SessionTarget =
      targetKind === 'child' && child
        ? { kind: 'child', parentAppSessionId: parent, childSessionId: child }
        : { kind: 'session', appSessionId: parent };
    const reconstructed: Record<string, unknown> = {
      eventId,
      target,
      providerDriverKind: requiredString(row.provider_driver_kind, 'provider_driver_kind'),
      providerInstanceId: requiredString(row.provider_instance_id, 'provider_instance_id'),
      runtimeGeneration: sqlInteger(row.runtime_generation, 'runtime_generation'),
      createdAt: sqlInteger(row.created_at, 'created_at'),
      payload: parseCanonicalEventPayload(parseJson(payloadJson)),
    };
    const turnId = stringValue(row.turn_id);
    if (turnId) reconstructed.turnId = turnId;
    const native = nativeCorrelationFromRow(row);
    if (native) reconstructed.nativeCorrelation = native;
    return {
      ...parseCanonicalEvent(reconstructed),
      seq: sqlInteger(row.event_order, 'event_order'),
    };
  }
}

function nativeCorrelationFromRow(
  row: Record<string, unknown>,
): CanonicalEvent['nativeCorrelation'] {
  const sessionId = stringValue(row.provider_session_id);
  const turnId = stringValue(row.provider_turn_id);
  const itemId = stringValue(row.provider_item_id);
  if (!sessionId && !turnId && !itemId) return undefined;
  const native: NonNullable<CanonicalEvent['nativeCorrelation']> = {};
  if (sessionId) native.sessionId = sessionId;
  if (turnId) native.turnId = turnId;
  if (itemId) native.itemId = itemId;
  return native;
}

function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
}

function parsePageCursor(cursor: string): number {
  if (!/^[0-9]+$/.test(cursor)) throw new InvalidTranscriptCursorError(cursor);
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new InvalidTranscriptCursorError(cursor);
  return value;
}

function parseStoredTimestamp(value: string, label: string): number {
  if (/^[0-9]+$/.test(value)) {
    const ms = Number(value);
    if (Number.isSafeInteger(ms) && ms >= 0) return ms;
  }
  const ms = Date.parse(value);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  throw new Error(`Invalid turn ${label} ${value}.`);
}

function sqlInteger(value: unknown, label: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Canonical transcript ${label} is out of range.`);
    }
    return Number(value);
  }
  const parsed = numberValue(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Canonical transcript ${label} must be a nonnegative integer.`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`Canonical transcript ${label} is missing.`);
  return parsed;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function turnInsertError(turnId: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/unique/i.test(message)) return new Error(`Turn ${turnId} already exists.`);
  return error instanceof Error ? error : new Error(message);
}

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

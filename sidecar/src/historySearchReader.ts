import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { decodeProviderSessionIdList } from './historyProviderIds.js';
import { matchingHistoryProvidersSql, providerHistoryMatchesSql } from './historySearchSchema.js';
import type { SessionSearchResult } from './protocol.js';
import { buildSessionSearchSnippet } from './sessionSearch.js';
import { numberValue, stringValue } from './values.js';

const MIN_FTS_QUERY_LENGTH = 3;
const MAX_RESULTS = 25;
const MAX_MATCHES_PER_SESSION = 3;
const MAX_PROVIDER_CANDIDATES = MAX_RESULTS * 4;

interface CanonicalSessionIdentity {
  appSessionId: string;
  updatedAt: number;
}

interface IndexedSearchRow extends Record<string, unknown> {
  provider_session_id: unknown;
  author: unknown;
  ts: unknown;
  text: unknown;
  session_updated_at: unknown;
}

interface MatchingProviderRow extends Record<string, unknown> {
  provider_session_id: unknown;
}

interface CanonicalIdentityRow extends Record<string, unknown> {
  app_session_id: unknown;
  provider_session_id: unknown;
  compacted_from_provider_session_ids: unknown;
  updated_at: unknown;
}

interface GroupedSearchResult {
  appSessionId: string;
  updatedAt: number;
  matches: SessionSearchResult['matches'];
}

export class HistorySearchReader {
  private readonly matchingProviders: StatementSync;
  private readonly providerMatches: StatementSync;
  private readonly identityRevision: StatementSync;
  private readonly canonicalIdentityRows: StatementSync;
  private cachedIdentityRevision = -1;
  private cachedIdentities = new Map<string, CanonicalSessionIdentity>();

  constructor(indexDb: DatabaseSync, canonicalDb: DatabaseSync) {
    this.matchingProviders = indexDb.prepare(matchingHistoryProvidersSql());
    this.providerMatches = indexDb.prepare(providerHistoryMatchesSql());
    this.identityRevision = canonicalDb.prepare(
      "SELECT value_json FROM settings WHERE scope = 'history.search_identity_revision'",
    );
    this.canonicalIdentityRows = canonicalDb.prepare(`
      SELECT app_session_id, provider_session_id,
             compacted_from_provider_session_ids, updated_at
      FROM app_sessions
    `);
  }

  search(query: string, isStale?: () => boolean): SessionSearchResult[] {
    const queryLower = query.trim().toLowerCase();
    if (Array.from(queryLower).length < MIN_FTS_QUERY_LENGTH || isStale?.()) return [];
    const identities = this.currentCanonicalIdentities();
    const grouped = new Map<string, GroupedSearchResult>();
    const phrase = `"${queryLower.replaceAll('"', '""')}"`;
    const providers = this.matchingProviders.all(
      phrase,
      MAX_PROVIDER_CANDIDATES,
    ) as MatchingProviderRow[];
    for (const provider of providers) {
      if (isStale?.()) return [];
      const providerSessionId = stringValue(provider.provider_session_id);
      if (!providerSessionId) continue;
      const rows = this.providerMatches.all(
        phrase,
        providerSessionId,
        MAX_MATCHES_PER_SESSION,
      ) as IndexedSearchRow[];
      for (const row of rows) this.addSearchRow(grouped, identities, row, queryLower);
      if (grouped.size >= MAX_RESULTS) break;
    }
    return [...grouped.values()]
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || left.appSessionId.localeCompare(right.appSessionId),
      )
      .slice(0, MAX_RESULTS)
      .map(({ appSessionId, matches }) => ({
        appSessionId,
        matches: matches.sort((left, right) => right.ts - left.ts),
      }));
  }

  private addSearchRow(
    grouped: Map<string, GroupedSearchResult>,
    identities: Map<string, CanonicalSessionIdentity>,
    row: IndexedSearchRow,
    queryLower: string,
  ): void {
    const providerSessionId = stringValue(row.provider_session_id);
    const author = searchAuthor(row.author);
    const ts = numberValue(row.ts);
    const text = stringValue(row.text);
    if (!providerSessionId || !author || ts === undefined || text === undefined) return;
    const identity = identities.get(providerSessionId) ?? {
      appSessionId: providerSessionId,
      updatedAt: numberValue(row.session_updated_at) ?? 0,
    };
    const result = grouped.get(identity.appSessionId) ?? {
      appSessionId: identity.appSessionId,
      updatedAt: identity.updatedAt,
      matches: [],
    };
    if (result.matches.length >= MAX_MATCHES_PER_SESSION) return;
    const snippet = buildSessionSearchSnippet(text, queryLower);
    if (snippet === null) return;
    result.matches.push({ snippet, author, ts });
    grouped.set(identity.appSessionId, result);
  }

  private currentCanonicalIdentities(): Map<string, CanonicalSessionIdentity> {
    const row = this.identityRevision.get() as { value_json: unknown } | undefined;
    const revision = nonNegativeSafeIntegerValue(row?.value_json);
    if (revision === this.cachedIdentityRevision) return this.cachedIdentities;
    const identities = new Map<string, CanonicalSessionIdentity>();
    for (const raw of this.canonicalIdentityRows.all() as CanonicalIdentityRow[]) {
      const appSessionId = stringValue(raw.app_session_id);
      if (!appSessionId) continue;
      const identity = { appSessionId, updatedAt: numberValue(raw.updated_at) ?? 0 };
      identities.set(appSessionId, identity);
      const providerSessionId = stringValue(raw.provider_session_id);
      if (providerSessionId) identities.set(providerSessionId, identity);
      let aliases: string[];
      try {
        aliases = decodeProviderSessionIdList(raw.compacted_from_provider_session_ids);
      } catch {
        aliases = [];
      }
      for (const alias of aliases) {
        identities.set(alias, identity);
      }
    }
    this.cachedIdentityRevision = revision;
    this.cachedIdentities = identities;
    return identities;
  }
}

function searchAuthor(value: unknown): 'user' | 'assistant' | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

function nonNegativeSafeIntegerValue(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

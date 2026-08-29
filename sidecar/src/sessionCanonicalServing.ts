import type { HistorySearchReply, SessionSummary, TranscriptEvent } from './protocol.js';
import type { SessionStore, StoredSession } from './persistence/SessionStore.js';
import type { TranscriptStore } from './persistence/TranscriptStore.js';
import { projectTranscriptEvent } from './sessionEvents.js';
import { transcriptToMarkdown } from './sessionMarkdown.js';
import { projectWireSessionSummary } from './sessionRegistryProjection.js';
import {
  filterSessionListSummaries,
  type SessionListFilterOptions,
  type SessionListPage,
} from './sessionListFilter.js';

export class UnknownAppSessionError extends Error {
  constructor(readonly requestedAppSessionId: string) {
    super(`Unknown session ${requestedAppSessionId}.`);
    this.name = 'UnknownAppSessionError';
  }
}

export function requireStoredSession(
  store: Pick<SessionStore, 'get'>,
  requestedAppSessionId: string,
): StoredSession {
  const stored = store.get(requestedAppSessionId);
  if (!stored || stored.summary.appSessionId !== requestedAppSessionId) {
    throw new UnknownAppSessionError(requestedAppSessionId);
  }
  return stored;
}

export function listPageFromStore(
  store: Pick<SessionStore, 'list'>,
  options: SessionListFilterOptions,
  projectSummary: (summary: Readonly<SessionSummary>) => SessionSummary,
  live: ReadonlyMap<string, { summary: SessionSummary; binding?: StoredSession['binding'] }>,
): SessionListPage {
  const rows = new Map<string, { summary: SessionSummary; binding?: StoredSession['binding'] }>();
  for (const row of store.list()) {
    rows.set(row.summary.appSessionId, { summary: row.summary, binding: row.binding });
  }
  for (const [appSessionId, entry] of live) {
    rows.set(appSessionId, entry);
  }
  const projected = [...rows.values()]
    .map((entry) => projectWireSessionSummary(entry.summary, projectSummary, entry.binding))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return filterSessionListSummaries(projected, options, () => true);
}

export function historyPageFromStore(
  transcriptStore: Pick<TranscriptStore, 'page'>,
  appSessionId: string,
  cursor?: string,
  limit?: number,
): { transcripts: TranscriptEvent[]; olderCursor?: string } {
  const page = transcriptStore.page({
    kind: 'session',
    appSessionId,
    ...(cursor !== undefined ? { before: cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  const transcripts = page.events.flatMap((event) => {
    const projected = projectTranscriptEvent(event);
    return projected ? [{ ...projected, appSessionId }] : [];
  });
  return {
    transcripts,
    ...(page.olderCursor !== undefined ? { olderCursor: page.olderCursor } : {}),
  };
}

export async function searchFromStore(
  transcriptStore: Pick<TranscriptStore, 'search'>,
  query: string,
  isStale?: () => boolean,
): Promise<HistorySearchReply> {
  return {
    results: await transcriptStore.search(query, isStale),
    indexingIncomplete: false,
  };
}

export function exportMarkdownFromStore(
  transcriptStore: Pick<TranscriptStore, 'page'>,
  stored: StoredSession,
  title?: string,
): string {
  const page = transcriptStore.page({
    kind: 'session',
    appSessionId: stored.summary.appSessionId,
    limit: 100_000,
  });
  const events = page.events.flatMap((event) => {
    const projected = projectTranscriptEvent(event);
    return projected ? [projected] : [];
  });
  if (events.length === 0) throw new Error('No stored transcript for this chat.');
  return transcriptToMarkdown(events, {
    title: title ?? stored.summary.title ?? 'Chat export',
    appSessionId: stored.summary.appSessionId,
    cwd: stored.summary.cwd,
    ...(page.olderCursor !== undefined
      ? {
          note: 'This chat exceeds the 100,000-event export limit; only the most recent events are included.',
        }
      : {}),
  });
}

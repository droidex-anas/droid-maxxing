import type { ClientCommand, HistorySearchReply, ServerEvent, SessionSummary } from './protocol.js';
import { loadSessionTranscriptWindow, resolveSessionChain } from './history.js';
import { isHistorySearchUnavailableError } from './historySearchSchema.js';
import { errMsg } from './sessionHelpers.js';
import { transcriptToMarkdown } from './sessionMarkdown.js';

type Emit = (event: ServerEvent) => void;

export interface SessionHistoryQueriesDependencies {
  searchSessions: (query: string, isStale?: () => boolean) => Promise<HistorySearchReply>;
  resolveSummary: (appSessionId: string) => SessionSummary | undefined;
  emit: Emit;
}

export class SessionHistoryQueries {
  // Newest sessions.search requestId; older in-flight scans check staleness
  // against this and stop early instead of finishing a discarded scan.
  private latestSearchRequestId: string | null = null;

  constructor(private readonly d: SessionHistoryQueriesDependencies) {}

  async search(cmd: Extract<ClientCommand, { type: 'sessions.search' }>): Promise<void> {
    // Track the newest query so a superseded FTS query stops before
    // publishing results the renderer would discard by requestId anyway.
    this.latestSearchRequestId = cmd.requestId;
    const isStale = (): boolean => this.latestSearchRequestId !== cmd.requestId;
    try {
      const reply = await this.d.searchSessions(cmd.query, isStale);
      if (!isStale()) {
        this.d.emit({
          type: 'sessions.searchResults',
          requestId: cmd.requestId,
          results: reply.results,
          indexingIncomplete: reply.indexingIncomplete,
        });
      }
    } catch (error) {
      if (!isHistorySearchUnavailableError(error)) throw error;
      if (!isStale()) {
        this.d.emit({
          type: 'error',
          code: 'history.search_unavailable',
          requestId: cmd.requestId,
          message: errMsg(error),
          recoverable: false,
        });
      }
    }
  }

  // Reads the stored .jsonl files straight from disk, so the export is
  // complete even for a chat the renderer never opened (its transcript is not
  // in memory). Compaction rekeys the backing session, so the full chain must
  // be replayed like the chat scrollback — otherwise pre-compaction messages
  // silently vanish from the export.
  exportMarkdown(cmd: { appSessionId: string; requestId: string; title?: string }): void {
    try {
      const summary = this.d.resolveSummary(cmd.appSessionId);
      const providerSessionId = summary?.providerSessionId ?? cmd.appSessionId;
      const appSessionId = summary?.appSessionId ?? cmd.appSessionId;
      const chain = resolveSessionChain(appSessionId, providerSessionId);
      const { events, olderCursor } = loadSessionTranscriptWindow(appSessionId, chain, {
        limit: 100_000,
      });
      if (events.length === 0) throw new Error('No stored transcript for this chat.');
      const markdown = transcriptToMarkdown(events, {
        title: cmd.title ?? summary?.title ?? 'Chat export',
        appSessionId,
        cwd: summary?.cwd,
        // The window caps at 100k events; an export missing older turns must
        // say so rather than read as the complete chat.
        ...(olderCursor !== undefined
          ? {
              note: 'This chat exceeds the 100,000-event export limit; only the most recent events are included.',
            }
          : {}),
      });
      this.d.emit({
        type: 'session.markdownExported',
        requestId: cmd.requestId,
        ok: true,
        markdown,
      });
    } catch (error) {
      // The raw error can carry internal paths; the renderer shows a generic
      // failure toast while the detail stays in the sidecar log.
      console.error(`Markdown export failed: ${errMsg(error)}`);
      this.d.emit({
        type: 'session.markdownExported',
        requestId: cmd.requestId,
        ok: false,
        message: 'Could not export this chat.',
      });
    }
  }

  forget(): void {
    this.latestSearchRequestId = null;
  }
}

import type { ClientCommand, HistorySearchReply, ServerEvent, SessionSummary } from './protocol.js';
import type { SessionStore } from './persistence/SessionStore.js';
import type { TranscriptStore } from './persistence/TranscriptStore.js';
import { errMsg } from './sessionHelpers.js';
import { exportMarkdownFromStore, requireStoredSession } from './sessionCanonicalServing.js';

type Emit = (event: ServerEvent) => void;

export interface SessionHistoryQueriesDependencies {
  searchSessions: (query: string, isStale?: () => boolean) => Promise<HistorySearchReply>;
  resolveSummary: (appSessionId: string) => SessionSummary | undefined;
  emit: Emit;
  sessionStore?: Pick<SessionStore, 'get'>;
  transcriptStore?: Pick<TranscriptStore, 'page'>;
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

  exportMarkdown(cmd: { appSessionId: string; requestId: string; title?: string }): void {
    try {
      if (!this.d.sessionStore || !this.d.transcriptStore) {
        throw new Error('Canonical transcript store is required.');
      }
      const stored = requireStoredSession(this.d.sessionStore, cmd.appSessionId);
      const markdown = exportMarkdownFromStore(this.d.transcriptStore, stored, cmd.title);
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

import type {
  ChildSessionSummary,
  ContextStatsSnapshot,
  ProgressEntry,
  SessionSummary,
  TranscriptEvent,
} from '../types/bridge';
import {
  reconcilePrependedTranscript,
  reconcileRestoredTranscript,
  reconcileTranscriptSourcePage,
} from '../lib/transcriptHistory';
import { detectPureTranscriptPrepend } from '../lib/transcriptMutation';
import { withUpdatedTranscript } from '../lib/transcriptStoreMemory';
import { estimateTranscriptCost } from '../lib/transcriptWindow';
import {
  releaseInactiveChildTranscript,
  withChildHistory,
  type ChildSessionInfo,
  type ChildSessionStore,
} from './storeChildSession';

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */

interface SessionRestoreStore extends ChildSessionStore {
  progress: Record<string, ProgressEntry[]>;
  sessions: Record<string, SessionSummary>;
  contextStats: ChildSessionStore['contextStats'] & {
    primary: Record<string, ContextStatsSnapshot>;
  };
}

function withHistoricalCompactionGeneration<S extends SessionRestoreStore>(
  state: S,
  appSessionId: string,
  transcript: TranscriptEvent[],
): S {
  const session = state.sessions[appSessionId];
  if (!session) return state;

  const compactionMarkers = transcript.filter(
    (event) => event.kind === 'compaction' && event.role === 'primary',
  );
  const restoredCompactions = Math.max(
    compactionMarkers.filter((event) => event.id.startsWith('compaction-')).length,
    compactionMarkers.filter((event) => !event.id.startsWith('compaction-')).length,
  );
  const currentCompactions = session.autoCompactions ?? 0;
  if (restoredCompactions <= currentCompactions) return state;

  const primaryContext = Object.fromEntries(
    Object.entries(state.contextStats.primary).filter(([id]) => id !== appSessionId),
  );
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [appSessionId]: {
        ...session,
        autoCompactions: restoredCompactions,
        contextTokens: 0,
        contextRemainingTokens: undefined,
        contextAccuracy: undefined,
        contextUpdatedAt: undefined,
      },
    },
    contextStats: { ...state.contextStats, primary: primaryContext },
  };
}

export function reduceSessionHistoryLoadingOlder<S extends SessionRestoreStore>(
  state: S,
  action: { appSessionId: string },
): S {
  return {
    ...state,
    historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: true },
  };
}

export function reduceSessionRestoreStart<S extends SessionRestoreStore>(
  state: S,
  action: { appSessionId: string },
): S {
  const prev = state.sessionRestore[action.appSessionId];
  return {
    ...state,
    sessionRestore: {
      ...state.sessionRestore,
      [action.appSessionId]: {
        status: 'loading',
        loadedCount: prev?.loadedCount ?? 0,
        hasMore: prev?.hasMore ?? false,
      },
    },
  };
}

export function reduceSessionHistoryFailed<S extends SessionRestoreStore>(
  state: S,
  action: { appSessionId: string; childSessionId?: string; message: string },
): S {
  if (action.childSessionId) {
    const prev = state.childHistory[action.appSessionId]?.[action.childSessionId];
    return withChildHistory(state, action.appSessionId, action.childSessionId, {
      status: 'failed',
      loadedCount: prev?.loadedCount ?? 0,
      hasMore: prev?.hasMore ?? false,
      error: action.message,
      isLoaded: prev?.isLoaded ?? false,
      isLoadingOlder: false,
      olderCursor: prev?.olderCursor,
      isViewportPinned: prev?.isViewportPinned ?? true,
    });
  }
  const prev = state.sessionRestore[action.appSessionId];
  return {
    ...state,
    historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
    sessionRestore: {
      ...state.sessionRestore,
      [action.appSessionId]: {
        status: 'failed',
        loadedCount: prev?.loadedCount ?? 0,
        hasMore: prev?.hasMore ?? false,
        error: action.message,
      },
    },
  };
}

export function reduceSessionHistory<S extends SessionRestoreStore>(
  state: S,
  action: {
    appSessionId: string;
    childSessionId?: string;
    progress: ProgressEntry[];
    transcripts: TranscriptEvent[];
    childSessions?: ChildSessionSummary[];
    mode?: 'replace' | 'prepend';
    olderCursor?: string;
    loadedCount?: number;
    hasMore?: boolean;
  },
): S {
  const existing = state.transcripts[action.appSessionId] ?? [];
  const hasMore = Boolean(action.olderCursor);

  if (action.childSessionId) {
    const reconciled = reconcileTranscriptSourcePage(
      existing,
      action.childSessionId,
      action.transcripts,
      action.mode ?? 'replace',
      hasMore,
    );
    const transcriptChanged = reconciled.transcript !== existing;
    const previousHistory = state.childHistory[action.appSessionId]?.[action.childSessionId];
    const historyState = withChildHistory(state, action.appSessionId, action.childSessionId, {
      status: hasMore ? 'paged' : 'loaded',
      loadedCount: reconciled.sourceEvents.length,
      hasMore,
      isLoaded: true,
      isLoadingOlder: false,
      olderCursor: action.olderCursor,
      isViewportPinned: previousHistory?.isViewportPinned ?? true,
    });
    const next = transcriptChanged
      ? withUpdatedTranscript(
          historyState,
          action.appSessionId,
          reconciled.transcript,
          estimateTranscriptCost(reconciled.transcript),
          {
            childSessionId: action.childSessionId,
            mutation:
              action.mode === 'prepend'
                ? detectPureTranscriptPrepend(existing, reconciled.transcript)
                : undefined,
          },
        )
      : historyState;
    const isSelected =
      next.selectedChild?.parentAppSessionId === action.appSessionId &&
      next.selectedChild.childSessionId === action.childSessionId;
    return isSelected
      ? next
      : releaseInactiveChildTranscript(next, action.appSessionId, action.childSessionId);
  }

  if (action.mode === 'prepend') {
    const mergedTranscript = reconcilePrependedTranscript(existing, action.transcripts);
    const transcriptChanged = mergedTranscript !== existing;
    const historyState = {
      ...state,
      historyCursor: { ...state.historyCursor, [action.appSessionId]: action.olderCursor },
      historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
      sessionRestore: {
        ...state.sessionRestore,
        [action.appSessionId]: {
          status: hasMore ? 'paged' : 'loaded',
          loadedCount: mergedTranscript.length,
          hasMore,
        },
      },
    };
    const next = transcriptChanged
      ? withUpdatedTranscript(
          historyState,
          action.appSessionId,
          mergedTranscript,
          estimateTranscriptCost(mergedTranscript),
          { mutation: detectPureTranscriptPrepend(existing, mergedTranscript) },
        )
      : historyState;
    return withHistoricalCompactionGeneration(next, action.appSessionId, mergedTranscript);
  }

  const mergedTranscript = reconcileRestoredTranscript(existing, action.transcripts, !hasMore);
  const transcriptChanged = mergedTranscript !== existing;
  const historicalChildren = action.childSessions ?? [];
  const existingChildSessions = state.childSessions[action.appSessionId] ?? {};
  let childSessions: Record<string, Record<string, ChildSessionInfo>> = state.childSessions;
  if (historicalChildren.length > 0) {
    const byChild = { ...existingChildSessions };
    for (const child of historicalChildren)
      byChild[child.childSessionId] = byChild[child.childSessionId] ?? child;
    childSessions = {
      ...state.childSessions,
      [action.appSessionId]: byChild,
    };
  }
  // An empty restore (e.g. a live session with no persisted history yet)
  // must not wipe progress already delivered by live events; only adopt the
  // replayed progress when it actually carries entries.
  const existingProgress = state.progress[action.appSessionId] ?? [];
  const mergedProgress = action.progress.length > 0 ? action.progress : existingProgress;
  const historyState = {
    ...state,
    progress: { ...state.progress, [action.appSessionId]: mergedProgress },
    childSessions,
    historyLoaded: { ...state.historyLoaded, [action.appSessionId]: true },
    historyCursor: { ...state.historyCursor, [action.appSessionId]: action.olderCursor },
    historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
    sessionRestore: {
      ...state.sessionRestore,
      [action.appSessionId]: {
        status: hasMore ? 'paged' : 'loaded',
        loadedCount: mergedTranscript.length,
        hasMore,
      },
    },
  };
  const next = transcriptChanged
    ? withUpdatedTranscript(
        historyState,
        action.appSessionId,
        mergedTranscript,
        estimateTranscriptCost(mergedTranscript),
      )
    : historyState;
  return withHistoricalCompactionGeneration(next, action.appSessionId, mergedTranscript);
}

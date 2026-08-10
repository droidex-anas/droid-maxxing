import type { AppState } from '../hooks/useStore';
import type { TranscriptEvent } from '../types/bridge';
import {
  EMERGENCY_TRANSCRIPT_POLICY,
  estimateAppendedTranscriptCost,
  estimateReplacedTranscriptTailCost,
  estimateTranscriptCost,
  releaseTranscriptWindow,
  type TranscriptWindow,
  type TranscriptWindowPolicy,
} from './transcriptWindow';

// Protocol mirror of sidecar/src/SessionTimeline.ts. Normal older-page scrolls
// stay smaller; this larger one-shot page only repairs a released recent tail.
const MAX_RECENT_REHYDRATION_EVENTS = 1_600;

export function transcriptRehydrationLimit(
  restore: AppState['sessionRestore'][string] | undefined,
): number | undefined {
  if (restore?.status !== 'paged') return undefined;
  return Math.min(MAX_RECENT_REHYDRATION_EVENTS, Math.max(1, restore.loadedCount));
}

export function appendTranscriptEvent(state: AppState, event: TranscriptEvent): AppState {
  const appSessionId = event.appSessionId;
  const previous = state.transcripts[appSessionId] ?? [];
  if (previous.some((candidate) => candidate.id === event.id)) return state;
  const previousCost =
    state.transcriptRetainedCost[appSessionId] ?? estimateTranscriptCost(previous);
  const last = previous.at(-1);

  // Protocol mirror: sidecar/src/SessionTimeline.ts pre-coalesces these same
  // backend-only text/thinking runs.
  const textDelta = getTextDeltaRun(last, event);
  if (textDelta) {
    const merged = [...previous];
    const mergedTail: TranscriptEvent = {
      ...textDelta.previous,
      text: (textDelta.previous.text ?? '') + textDelta.text,
      endTs: event.endTs ?? event.ts,
    };
    merged[merged.length - 1] = mergedTail;
    return withUpdatedTranscript(
      state,
      appSessionId,
      merged,
      estimateReplacedTranscriptTailCost(previousCost, textDelta.previous, mergedTail),
    );
  }

  // A tool call streams partial snapshots under one toolUseId. Keep one stable
  // event and accumulate object fields so renderer and replay shapes match.
  const toolCallTail = getToolCallTail(last, event);
  if (toolCallTail) {
    const merged = [...previous];
    const mergedTail: TranscriptEvent = {
      ...toolCallTail,
      toolName: event.toolName ?? toolCallTail.toolName,
      toolArgs: mergeToolArgs(toolCallTail.toolArgs, event.toolArgs),
      endTs: event.endTs ?? event.ts,
    };
    merged[merged.length - 1] = mergedTail;
    return withUpdatedTranscript(
      state,
      appSessionId,
      merged,
      estimateReplacedTranscriptTailCost(previousCost, toolCallTail, mergedTail),
    );
  }

  return withUpdatedTranscript(
    state,
    appSessionId,
    [...previous, event],
    estimateAppendedTranscriptCost(previousCost, event),
  );
}

export function releaseSessionTranscriptWindow(
  state: AppState,
  appSessionId: string,
  policy: TranscriptWindowPolicy,
): AppState {
  const transcript = state.transcripts[appSessionId] ?? [];
  if (transcript.length === 0) return state;
  const estimatedCost =
    state.transcriptRetainedCost[appSessionId] ?? estimateTranscriptCost(transcript);
  const window = releasePrimaryTranscriptWindow(transcript, estimatedCost, policy);
  if (!window.released) {
    if (Object.hasOwn(state.transcriptRetainedCost, appSessionId)) return state;
    return {
      ...state,
      transcriptRetainedCost: {
        ...state.transcriptRetainedCost,
        [appSessionId]: estimatedCost,
      },
    };
  }

  return {
    ...state,
    transcripts: { ...state.transcripts, [appSessionId]: window.events },
    transcriptRetainedCost: {
      ...state.transcriptRetainedCost,
      [appSessionId]: window.estimatedCost,
    },
    // A cursor describes the boundary before the exact in-memory page that
    // produced it. Releasing rows invalidates that boundary, so force an
    // invisible recent-page refresh before older paging resumes.
    historyLoaded: { ...state.historyLoaded, [appSessionId]: false },
    historyCursor: { ...state.historyCursor, [appSessionId]: undefined },
    historyLoadingOlder: { ...state.historyLoadingOlder, [appSessionId]: false },
    sessionRestore: {
      ...state.sessionRestore,
      [appSessionId]: {
        status: 'paged',
        loadedCount: window.events.length,
        hasMore: true,
      },
    },
  };
}

export function withUpdatedTranscript(
  state: AppState,
  appSessionId: string,
  transcript: TranscriptEvent[],
  estimatedCost: number,
): AppState {
  const next = {
    ...state,
    transcripts: { ...state.transcripts, [appSessionId]: transcript },
    transcriptRetainedCost: {
      ...state.transcriptRetainedCost,
      [appSessionId]: estimatedCost,
    },
  };
  return releaseSessionTranscriptWindow(next, appSessionId, EMERGENCY_TRANSCRIPT_POLICY);
}

export function pruneRemovedSessionState(
  state: AppState,
  retainedSessionIds: ReadonlySet<string>,
): AppState {
  const specWikiAppSessionId =
    state.specWikiAppSessionId && retainedSessionIds.has(state.specWikiAppSessionId)
      ? state.specWikiAppSessionId
      : null;
  const reviewOpenAppSessionId =
    state.reviewOpenAppSessionId && retainedSessionIds.has(state.reviewOpenAppSessionId)
      ? state.reviewOpenAppSessionId
      : null;
  return {
    ...state,
    sessionLastSeen: pruneSessionRecord(state.sessionLastSeen, retainedSessionIds),
    transcripts: pruneSessionRecord(state.transcripts, retainedSessionIds),
    transcriptRetainedCost: pruneSessionRecord(state.transcriptRetainedCost, retainedSessionIds),
    transcriptViewportPinned: pruneSessionRecord(
      state.transcriptViewportPinned,
      retainedSessionIds,
    ),
    progress: pruneSessionRecord(state.progress, retainedSessionIds),
    childSessions: pruneSessionRecord(state.childSessions, retainedSessionIds),
    historyLoaded: pruneSessionRecord(state.historyLoaded, retainedSessionIds),
    historyCursor: pruneSessionRecord(state.historyCursor, retainedSessionIds),
    historyLoadingOlder: pruneSessionRecord(state.historyLoadingOlder, retainedSessionIds),
    sessionRestore: pruneSessionRecord(state.sessionRestore, retainedSessionIds),
    childAccess: pruneSessionRecord(state.childAccess, retainedSessionIds),
    childRuntime: pruneSessionRecord(state.childRuntime, retainedSessionIds),
    contextStats: {
      primary: pruneSessionRecord(state.contextStats.primary, retainedSessionIds),
      child: pruneSessionRecord(state.contextStats.child, retainedSessionIds),
    },
    specPlans: pruneSessionRecord(state.specPlans, retainedSessionIds),
    sessionSpecs: pruneSessionRecord(state.sessionSpecs, retainedSessionIds),
    specWikiAppSessionId,
    promptQueue: pruneSessionRecord(state.promptQueue, retainedSessionIds),
    sessionNotes: pruneSessionRecord(state.sessionNotes, retainedSessionIds),
    utilityPanels: pruneSessionRecord(state.utilityPanels, retainedSessionIds),
    reviewOpenAppSessionId,
    pendingAutonomy: pruneSessionRecord(state.pendingAutonomy, retainedSessionIds),
    browserOpenKeys: pruneSessionRecord(state.browserOpenKeys, retainedSessionIds),
    browsers: pruneSessionRecord(state.browsers, retainedSessionIds),
    browserErrors: pruneSessionRecord(state.browserErrors, retainedSessionIds),
    designModes: pruneSessionRecord(state.designModes, retainedSessionIds),
    sessionSettingOverrides: pruneSessionRecord(state.sessionSettingOverrides, retainedSessionIds),
    pendingPermission:
      state.pendingPermission && retainedSessionIds.has(state.pendingPermission.appSessionId)
        ? state.pendingPermission
        : null,
    pendingQuestion:
      state.pendingQuestion && retainedSessionIds.has(state.pendingQuestion.appSessionId)
        ? state.pendingQuestion
        : null,
  };
}

function pruneSessionRecord<T>(
  record: Record<string, T>,
  retainedSessionIds: ReadonlySet<string>,
): Record<string, T> {
  let changed = false;
  const retained: Record<string, T> = {};
  for (const [appSessionId, value] of Object.entries(record)) {
    if (retainedSessionIds.has(appSessionId)) retained[appSessionId] = value;
    else changed = true;
  }
  return changed ? retained : record;
}

function mergeToolArgs(previous: unknown, next: unknown): unknown {
  if (isPlainRecord(previous) && isPlainRecord(next)) return { ...previous, ...next };
  return next ?? previous;
}

function releasePrimaryTranscriptWindow(
  transcript: TranscriptEvent[],
  estimatedCost: number,
  policy: TranscriptWindowPolicy,
): TranscriptWindow {
  const primaryEvents = transcript.filter(isPrimarySessionEvent);
  if (primaryEvents.length === transcript.length) {
    return releaseTranscriptWindow(transcript, estimatedCost, policy);
  }
  if (primaryEvents.length === 0) {
    return { events: transcript, estimatedCost, released: false };
  }

  // Primary history can be rehydrated through session.loadHistory. Child
  // transcripts use separate provider sessions and cannot share that cursor,
  // so never evict them under a primary-session release policy.
  const childEvents = transcript.filter((event) => !isPrimarySessionEvent(event));
  const primaryCost = Math.max(0, estimatedCost - estimateTranscriptCost(childEvents));
  const primaryWindow = releaseTranscriptWindow(primaryEvents, primaryCost, policy);
  if (!primaryWindow.released) {
    return { events: transcript, estimatedCost, released: false };
  }

  const retainedPrimaryIds = new Set(primaryWindow.events.map((event) => event.id));
  const events = transcript.filter(
    (event) => !isPrimarySessionEvent(event) || retainedPrimaryIds.has(event.id),
  );
  return {
    events,
    estimatedCost: estimateTranscriptCost(events),
    released: events.length < transcript.length,
  };
}

function isPrimarySessionEvent(event: TranscriptEvent): boolean {
  return event.role === 'primary' || (event.author === 'user' && event.sourceSessionId === 'user');
}

function getTextDeltaRun(
  previous: TranscriptEvent | undefined,
  next: TranscriptEvent,
): { previous: TranscriptEvent; text: string } | undefined {
  if (
    previous !== undefined &&
    !next.author &&
    previous.kind === next.kind &&
    previous.sourceSessionId === next.sourceSessionId &&
    previous.author === next.author &&
    (next.kind === 'text' || next.kind === 'thinking') &&
    typeof next.text === 'string' &&
    next.text.length > 0 &&
    !next.toolName
  ) {
    return { previous, text: next.text };
  }
  return undefined;
}

function getToolCallTail(
  previous: TranscriptEvent | undefined,
  next: TranscriptEvent,
): TranscriptEvent | undefined {
  if (
    previous !== undefined &&
    !next.author &&
    next.kind === 'tool_call' &&
    previous.kind === 'tool_call' &&
    previous.sourceSessionId === next.sourceSessionId &&
    !!next.toolUseId &&
    previous.toolUseId === next.toolUseId
  ) {
    return previous;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

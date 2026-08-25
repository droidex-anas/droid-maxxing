import type { AppState, ChildHistoryState } from '../hooks/useStore';
import type { TranscriptEvent } from '../types/bridge';
import { ingestTranscriptEvents, normalizeTranscriptUpdate } from './transcriptIngestion';
import { nextTranscriptMutation, type TranscriptMutationChange } from './transcriptMutation';
import {
  EMERGENCY_TRANSCRIPT_POLICY,
  estimateAppendedTranscriptCost,
  estimateTranscriptCost,
  releaseChildTranscriptWindow,
  releaseTranscriptWindow,
  shouldReleaseTranscriptWindow,
  type TranscriptWindow,
  type TranscriptWindowPolicy,
} from './transcriptWindow';

// Protocol mirror of sidecar/src/SessionTimeline.ts. Normal older-page scrolls
// stay smaller; this larger one-shot page only repairs a released recent tail.
const MAX_RECENT_REHYDRATION_EVENTS = 1_600;

export function transcriptRehydrationLimit(
  restore:
    | AppState['sessionRestore'][string]
    | AppState['childHistory'][string][string]
    | undefined,
): number | undefined {
  if (restore?.status !== 'paged') return undefined;
  return Math.min(MAX_RECENT_REHYDRATION_EVENTS, Math.max(1, restore.loadedCount));
}

export function appendTranscriptEvent(state: AppState, event: TranscriptEvent): AppState {
  const previous = state.transcripts[event.appSessionId] ?? [];
  const previousCost =
    state.transcriptRetainedCost[event.appSessionId] ?? estimateTranscriptCost(previous);
  const ingested = ingestTranscriptEvents(previous, previousCost, [event]);
  if (!ingested.change) return state;
  return withUpdatedTranscript(state, event.appSessionId, ingested.events, ingested.estimatedCost, {
    ...(event.role === 'primary' ? {} : { childSessionId: event.sourceSessionId }),
    mutation: ingested.change,
  });
}

export function appendTranscriptEvents(
  state: AppState,
  events: readonly TranscriptEvent[],
): AppState {
  const eventsBySession = new Map<string, TranscriptEvent[]>();
  for (const event of events) {
    const sessionEvents = eventsBySession.get(event.appSessionId);
    if (sessionEvents) sessionEvents.push(event);
    else eventsBySession.set(event.appSessionId, [event]);
  }

  let next = state;
  for (const [appSessionId, sessionEvents] of eventsBySession) {
    const previous = next.transcripts[appSessionId] ?? [];
    const previousCost =
      next.transcriptRetainedCost[appSessionId] ?? estimateTranscriptCost(previous);
    if (couldReachEmergencyWindow(previous, previousCost, sessionEvents)) {
      next = sessionEvents.reduce(appendTranscriptEvent, next);
      continue;
    }
    const ingested = ingestTranscriptEvents(previous, previousCost, sessionEvents);
    if (!ingested.change) continue;
    next = withUpdatedTranscript(next, appSessionId, ingested.events, ingested.estimatedCost, {
      mutation: ingested.change,
    });
  }
  return next;
}

function couldReachEmergencyWindow(
  previous: readonly TranscriptEvent[],
  previousCost: number,
  incoming: readonly TranscriptEvent[],
): boolean {
  if (previous.length + incoming.length > EMERGENCY_TRANSCRIPT_POLICY.highWaterEvents) return true;
  let upperCost = previousCost;
  for (const event of incoming) {
    upperCost = estimateAppendedTranscriptCost(upperCost, event);
    if (upperCost > EMERGENCY_TRANSCRIPT_POLICY.highWaterCost) return true;
  }
  return false;
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
  if (!shouldReleaseTranscriptWindow(transcript, estimatedCost, policy)) {
    if (Object.hasOwn(state.transcriptRetainedCost, appSessionId)) return state;
    return {
      ...state,
      transcriptRetainedCost: {
        ...state.transcriptRetainedCost,
        [appSessionId]: estimatedCost,
      },
    };
  }
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

  const next = replaceTranscript(
    state,
    appSessionId,
    window.events,
    window.estimatedCost,
    resetTranscript(transcript.length),
  );
  return {
    ...next,
    // A cursor describes the boundary before the exact in-memory page that
    // produced it. Releasing rows invalidates that boundary, so force an
    // invisible recent-page refresh before older paging resumes.
    historyLoaded: { ...next.historyLoaded, [appSessionId]: false },
    historyCursor: { ...next.historyCursor, [appSessionId]: undefined },
    historyLoadingOlder: { ...next.historyLoadingOlder, [appSessionId]: false },
    sessionRestore: {
      ...next.sessionRestore,
      [appSessionId]: {
        status: 'paged',
        loadedCount: window.events.length,
        hasMore: true,
      },
    },
  };
}

export function releaseSessionChildTranscriptWindow(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  policy: TranscriptWindowPolicy,
): AppState {
  // These keyed renderer maps are intentionally sparse at runtime despite
  // their long-standing Record types.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const transcript = state.transcripts[parentAppSessionId] ?? [];
  if (transcript.length === 0) return state;
  const estimatedCost =
    state.transcriptRetainedCost[parentAppSessionId] ?? estimateTranscriptCost(transcript);
  if (!shouldReleaseTranscriptWindow(transcript, estimatedCost, policy)) return state;
  const window = releaseChildTranscriptWindow(transcript, childSessionId, policy);
  if (!window.released) return state;
  const previousHistory = state.childHistory[parentAppSessionId]?.[childSessionId];
  const childEventCount = window.events.filter(
    (event) => event.sourceSessionId === childSessionId,
  ).length;
  const next = replaceTranscript(
    state,
    parentAppSessionId,
    window.events,
    window.estimatedCost,
    resetTranscript(transcript.length),
  );
  return {
    ...next,
    childHistory: {
      ...next.childHistory,
      [parentAppSessionId]: {
        ...(next.childHistory[parentAppSessionId] ?? {}),
        [childSessionId]: {
          status: 'paged',
          loadedCount: childEventCount,
          hasMore: true,
          isLoaded: false,
          isLoadingOlder: false,
          isViewportPinned: previousHistory?.isViewportPinned ?? true,
        },
      },
    },
  };
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}

export function withUpdatedTranscript(
  state: AppState,
  appSessionId: string,
  transcript: TranscriptEvent[],
  estimatedCost: number,
  options: {
    childSessionId?: string;
    mutation?: TranscriptMutationChange;
  } = {},
): AppState {
  // This keyed renderer map is intentionally sparse despite its Record type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const previousLength = state.transcripts[appSessionId]?.length ?? 0;
  let next = replaceTranscript(
    state,
    appSessionId,
    transcript,
    estimatedCost,
    options.mutation ?? resetTranscript(previousLength),
  );
  if (options.childSessionId) {
    next = releaseSessionChildTranscriptWindow(
      next,
      appSessionId,
      options.childSessionId,
      EMERGENCY_TRANSCRIPT_POLICY,
    );
  }
  next = releaseAggregateChildTranscriptWindows(next, appSessionId);
  return releaseSessionTranscriptWindow(next, appSessionId, EMERGENCY_TRANSCRIPT_POLICY);
}

function releaseAggregateChildTranscriptWindows(state: AppState, appSessionId: string): AppState {
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
  const transcript = state.transcripts[appSessionId] ?? [];
  const estimatedCost =
    state.transcriptRetainedCost[appSessionId] ?? estimateTranscriptCost(transcript);
  if (!shouldReleaseTranscriptWindow(transcript, estimatedCost, EMERGENCY_TRANSCRIPT_POLICY)) {
    return state;
  }

  const childSessionIds = Object.keys(state.childSessions[appSessionId] ?? {});
  if (childSessionIds.length === 0) return state;
  const sourcePolicy: TranscriptWindowPolicy = {
    ...EMERGENCY_TRANSCRIPT_POLICY,
    highWaterCost: Math.max(
      64 * 1024,
      Math.floor(EMERGENCY_TRANSCRIPT_POLICY.targetCost / childSessionIds.length),
    ),
    highWaterEvents: Math.max(
      15,
      Math.floor(EMERGENCY_TRANSCRIPT_POLICY.targetEvents / childSessionIds.length),
    ),
    targetCost: Math.max(
      32 * 1024,
      Math.floor(EMERGENCY_TRANSCRIPT_POLICY.targetCost / childSessionIds.length),
    ),
    targetEvents: Math.max(
      15,
      Math.floor(EMERGENCY_TRANSCRIPT_POLICY.targetEvents / childSessionIds.length),
    ),
    minimumEvents: 1,
    boundaryScanEvents: 24,
  };

  let events = transcript;
  let childHistory: Record<string, ChildHistoryState> = state.childHistory[appSessionId] ?? {};
  let released = false;
  for (const childSessionId of childSessionIds) {
    const window = releaseChildTranscriptWindow(events, childSessionId, sourcePolicy);
    if (!window.released) continue;
    released = true;
    events = window.events;
    const previousHistory = childHistory[childSessionId];
    const loadedCount = events.filter((event) => event.sourceSessionId === childSessionId).length;
    childHistory = {
      ...childHistory,
      [childSessionId]: {
        status: 'paged',
        loadedCount,
        hasMore: true,
        isLoaded: false,
        isLoadingOlder: false,
        isViewportPinned: previousHistory?.isViewportPinned ?? true,
      },
    };
  }
  if (!released) return state;
  const next = replaceTranscript(
    state,
    appSessionId,
    events,
    estimateTranscriptCost(events),
    resetTranscript(transcript.length),
  );
  return {
    ...next,
    childHistory: {
      ...next.childHistory,
      [appSessionId]: childHistory,
    },
  };
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
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
    transcriptMutations: pruneSessionRecord(state.transcriptMutations, retainedSessionIds),
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
    childHistory: pruneSessionRecord(state.childHistory, retainedSessionIds),
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
    pendingPermissions: pruneSessionRecord(state.pendingPermissions, retainedSessionIds),
    pendingQuestions: pruneSessionRecord(state.pendingQuestions, retainedSessionIds),
  };
}

function replaceTranscript(
  state: AppState,
  appSessionId: string,
  transcript: TranscriptEvent[],
  estimatedCost: number,
  mutation: TranscriptMutationChange,
): AppState {
  const previous = state.transcripts[appSessionId] ?? [];
  const normalized = normalizeTranscriptUpdate(previous, transcript, mutation);
  return {
    ...state,
    transcripts: { ...state.transcripts, [appSessionId]: normalized },
    transcriptMutations: {
      ...state.transcriptMutations,
      [appSessionId]: nextTranscriptMutation(state.transcriptMutations[appSessionId], mutation),
    },
    transcriptRetainedCost: {
      ...state.transcriptRetainedCost,
      [appSessionId]: estimatedCost,
    },
  };
}

function resetTranscript(previousLength: number): TranscriptMutationChange {
  return { kind: 'reset', previousLength, firstChangedIndex: 0 };
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

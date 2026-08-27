import type { ChildSessionSummary, ContextStatsSnapshot, TranscriptEvent } from '../types/bridge';
import { releaseSessionChildTranscriptWindow } from '../lib/transcriptStoreMemory';
import type { TranscriptMutation } from '../lib/transcriptMutation';
import { INACTIVE_TRANSCRIPT_POLICY, VIEWPORT_TRANSCRIPT_POLICY } from '../lib/transcriptWindow';

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
/* eslint-disable @typescript-eslint/no-dynamic-delete -- sparse childAccess parent keys */

export type ChildSettingsReadiness = 'opening' | 'ready' | 'failed';

export type ChildSessionInfo = ChildSessionSummary;

export interface ChildSelection {
  parentAppSessionId: string;
  childSessionId: string;
}

export type ChildAccess =
  | { state: 'opening'; requestId: string }
  | { state: 'ready'; requestId: string; runtimeGeneration: number }
  | { state: 'history'; requestId: string }
  | { state: 'failed'; requestId: string | null }
  | { state: 'closed'; requestId: null };

export interface ChildRuntimeState {
  available: boolean;
  runtimeGeneration: number;
}

export type SessionRestoreStatus = 'loading' | 'paged' | 'loaded' | 'failed';

export interface SessionRestore {
  status: SessionRestoreStatus;
  loadedCount: number;
  hasMore: boolean;
  error?: string;
}

export interface ChildHistoryState extends SessionRestore {
  isLoaded: boolean;
  isLoadingOlder: boolean;
  olderCursor?: string;
  isViewportPinned: boolean;
}

export interface ChildSessionStore {
  childAccess: Record<string, Record<string, ChildAccess>>;
  childRuntime: Record<string, Record<string, ChildRuntimeState>>;
  childHistory: Record<string, Record<string, ChildHistoryState>>;
  childSessions: Record<string, Record<string, ChildSessionInfo>>;
  selectedChild: ChildSelection | null;
  activeAppSessionId: string | null;
  contextStats: {
    primary: Record<string, ContextStatsSnapshot>;
    child: Record<string, Record<string, ContextStatsSnapshot>>;
  };
  transcripts: Record<string, TranscriptEvent[]>;
  transcriptMutations: Record<string, TranscriptMutation>;
  transcriptRetainedCost: Record<string, number>;
  historyLoaded: Record<string, boolean>;
  historyCursor: Record<string, string | undefined>;
  historyLoadingOlder: Record<string, boolean>;
  sessionRestore: Partial<Record<string, SessionRestore>>;
}

function withChildAccess<S extends ChildSessionStore>(
  state: S,
  parentAppSessionId: string,
  childSessionId: string,
  access: ChildAccess,
): S {
  const parent = state.childAccess[parentAppSessionId] ?? {};
  return {
    ...state,
    childAccess: {
      ...state.childAccess,
      [parentAppSessionId]: { ...parent, [childSessionId]: access },
    },
  };
}

function withoutChildAccess<S extends ChildSessionStore>(
  state: S,
  parentAppSessionId: string,
  childSessionId: string,
): S {
  const parent = { ...(state.childAccess[parentAppSessionId] ?? {}) };
  delete parent[childSessionId];
  const childAccess = { ...state.childAccess };
  if (Object.keys(parent).length === 0) delete childAccess[parentAppSessionId];
  else childAccess[parentAppSessionId] = parent;
  return { ...state, childAccess };
}

function withChildRuntime<S extends ChildSessionStore>(
  state: S,
  parentAppSessionId: string,
  childSessionId: string,
  runtime: ChildRuntimeState,
): S {
  const parent = state.childRuntime[parentAppSessionId] ?? {};
  return {
    ...state,
    childRuntime: {
      ...state.childRuntime,
      [parentAppSessionId]: { ...parent, [childSessionId]: runtime },
    },
  };
}

export function withChildHistory<S extends ChildSessionStore>(
  state: S,
  parentAppSessionId: string,
  childSessionId: string,
  history: ChildHistoryState,
): S {
  return {
    ...state,
    childHistory: {
      ...state.childHistory,
      [parentAppSessionId]: {
        ...state.childHistory[parentAppSessionId],
        [childSessionId]: history,
      },
    },
  };
}

export function releaseInactiveChildTranscript<S extends ChildSessionStore>(
  state: S,
  parentAppSessionId: string,
  childSessionId: string,
): S {
  // These keyed renderer maps are intentionally sparse at runtime despite
  // their long-standing Record types.
  const history = state.childHistory[parentAppSessionId]?.[childSessionId];
  if (history && (!history.isLoaded || !history.isViewportPinned)) return state;
  const child = state.childSessions[parentAppSessionId]?.[childSessionId];
  const runtime = state.childRuntime[parentAppSessionId]?.[childSessionId];
  if (child?.status === 'running' && runtime?.available) return state;
  return releaseSessionChildTranscriptWindow(
    state,
    parentAppSessionId,
    childSessionId,
    INACTIVE_TRANSCRIPT_POLICY,
  );
}

export function releaseInactiveSelectedChild<S extends ChildSessionStore>(state: S): S {
  const selected = state.selectedChild;
  return selected
    ? releaseInactiveChildTranscript(state, selected.parentAppSessionId, selected.childSessionId)
    : state;
}

export function invalidateSelectedChildOpening<S extends ChildSessionStore>(state: S): S {
  const selected = state.selectedChild;
  if (!selected) return state;
  const access = state.childAccess[selected.parentAppSessionId]?.[selected.childSessionId];
  return access?.state === 'opening'
    ? withChildAccess(state, selected.parentAppSessionId, selected.childSessionId, {
        state: 'closed',
        requestId: null,
      })
    : state;
}

export function reduceSessionChild<S extends ChildSessionStore>(
  state: S,
  action: {
    child: ChildSessionSummary;
    runtimeAvailable: boolean;
    runtimeGeneration: number;
  },
): S {
  const child = action.child;
  const parent = state.childSessions[child.parentAppSessionId] ?? {};
  const previousChild = parent[child.childSessionId];
  const runtimeParent = state.childRuntime[child.parentAppSessionId] ?? {};
  const previousRuntime = runtimeParent[child.childSessionId];
  if (previousRuntime && action.runtimeGeneration < previousRuntime.runtimeGeneration) return state;
  const settledWhileInactive =
    previousChild?.status === 'running' &&
    previousRuntime?.available &&
    (child.status !== 'running' || !action.runtimeAvailable) &&
    (state.activeAppSessionId !== child.parentAppSessionId ||
      state.selectedChild?.parentAppSessionId !== child.parentAppSessionId ||
      state.selectedChild.childSessionId !== child.childSessionId);
  const clearContext =
    !action.runtimeAvailable ||
    (previousRuntime !== undefined && action.runtimeGeneration > previousRuntime.runtimeGeneration);
  const contextParent = state.contextStats.child[child.parentAppSessionId] ?? {};
  let next = {
    ...state,
    childSessions: {
      ...state.childSessions,
      [child.parentAppSessionId]: {
        ...parent,
        [child.childSessionId]: child,
      },
    },
    contextStats: clearContext
      ? {
          ...state.contextStats,
          child: {
            ...state.contextStats.child,
            [child.parentAppSessionId]: Object.fromEntries(
              Object.entries(contextParent).filter(
                ([childSessionId]) => childSessionId !== child.childSessionId,
              ),
            ),
          },
        }
      : state.contextStats,
  };
  const runtimeUnchanged =
    // Keep the existence guard because the following comparison dereferences previousRuntime.
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    previousRuntime &&
    action.runtimeGeneration === previousRuntime.runtimeGeneration &&
    action.runtimeAvailable === previousRuntime.available;
  if (!runtimeUnchanged) {
    next = {
      ...next,
      childRuntime: {
        ...state.childRuntime,
        [child.parentAppSessionId]: {
          ...runtimeParent,
          [child.childSessionId]: {
            available: action.runtimeAvailable,
            runtimeGeneration: action.runtimeGeneration,
          },
        },
      },
    };
    const access = state.childAccess[child.parentAppSessionId]?.[child.childSessionId];
    if (!action.runtimeAvailable && (access?.state === 'opening' || access?.state === 'ready'))
      next = withChildAccess(next, child.parentAppSessionId, child.childSessionId, {
        state: 'closed',
        requestId: null,
      });
    else if (action.runtimeAvailable && access?.state === 'ready')
      next = withChildAccess(next, child.parentAppSessionId, child.childSessionId, {
        ...access,
        runtimeGeneration: action.runtimeGeneration,
      });
  }
  return settledWhileInactive
    ? releaseInactiveChildTranscript(next, child.parentAppSessionId, child.childSessionId)
    : next;
}

export function reduceChildUpdated<S extends ChildSessionStore>(
  state: S,
  action:
    | {
        parentAppSessionId: string;
        childSessionId: string;
        requestId: string;
        access: 'ready';
        runtimeGeneration: number;
      }
    | {
        parentAppSessionId: string;
        childSessionId: string;
        requestId: string;
        access: 'history';
      },
): S {
  if (
    state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
    state.selectedChild.childSessionId !== action.childSessionId
  )
    return state;
  const current = state.childAccess[action.parentAppSessionId]?.[action.childSessionId];
  if (current?.state !== 'opening' || current.requestId !== action.requestId) return state;
  const runtime = state.childRuntime[action.parentAppSessionId]?.[action.childSessionId];
  if (
    action.access === 'ready' &&
    runtime &&
    (action.runtimeGeneration < runtime.runtimeGeneration ||
      (action.runtimeGeneration === runtime.runtimeGeneration && !runtime.available))
  )
    return state;
  const settled = withChildAccess(
    state,
    action.parentAppSessionId,
    action.childSessionId,
    action.access === 'ready'
      ? {
          state: 'ready',
          requestId: action.requestId,
          runtimeGeneration: action.runtimeGeneration,
        }
      : { state: 'history', requestId: action.requestId },
  );
  return action.access === 'ready'
    ? withChildRuntime(settled, action.parentAppSessionId, action.childSessionId, {
        available: true,
        runtimeGeneration: action.runtimeGeneration,
      })
    : settled;
}

export function reduceChildError<S extends ChildSessionStore>(
  state: S,
  action: {
    parentAppSessionId: string;
    childSessionId: string;
    requestId: string | null;
    operation: 'open' | 'loadHistory' | 'send' | 'sendNow' | 'interrupt' | 'settings';
    message: string;
  },
): S {
  if (action.operation === 'loadHistory') {
    const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
    const next = withChildHistory(state, action.parentAppSessionId, action.childSessionId, {
      status: 'failed',
      loadedCount: previous?.loadedCount ?? 0,
      hasMore: previous?.hasMore ?? false,
      error: action.message,
      isLoaded: previous?.isLoaded ?? false,
      isLoadingOlder: false,
      olderCursor: previous?.olderCursor,
      isViewportPinned: previous?.isViewportPinned ?? true,
    });
    return next;
  }
  if (action.operation !== 'open' || !action.requestId) return state;
  if (
    state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
    state.selectedChild.childSessionId !== action.childSessionId
  )
    return state;
  const current = state.childAccess[action.parentAppSessionId]?.[action.childSessionId];
  if (current?.state !== 'opening' || current.requestId !== action.requestId) return state;
  return withChildAccess(state, action.parentAppSessionId, action.childSessionId, {
    state: 'failed',
    requestId: action.requestId,
  });
}

export function reduceChildHistoryLoading<S extends ChildSessionStore>(
  state: S,
  action: { parentAppSessionId: string; childSessionId: string },
): S {
  const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
  return withChildHistory(state, action.parentAppSessionId, action.childSessionId, {
    status: 'loading',
    loadedCount: previous?.loadedCount ?? 0,
    hasMore: previous?.hasMore ?? false,
    isLoaded: false,
    isLoadingOlder: false,
    olderCursor: undefined,
    isViewportPinned: previous?.isViewportPinned ?? true,
  });
}

export function reduceChildHistoryLoadingOlder<S extends ChildSessionStore>(
  state: S,
  action: { parentAppSessionId: string; childSessionId: string },
): S {
  const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
  if (!previous || previous.isLoadingOlder) return state;
  return withChildHistory(state, action.parentAppSessionId, action.childSessionId, {
    ...previous,
    isLoadingOlder: true,
  });
}

export function reduceChildTranscriptViewport<S extends ChildSessionStore>(
  state: S,
  action: { parentAppSessionId: string; childSessionId: string; pinned: boolean },
): S {
  const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
  if (!previous || previous.isViewportPinned === action.pinned) return state;
  return {
    ...state,
    childHistory: {
      ...state.childHistory,
      [action.parentAppSessionId]: {
        ...state.childHistory[action.parentAppSessionId],
        [action.childSessionId]: {
          ...previous,
          isViewportPinned: action.pinned,
        },
      },
    },
  };
}

export function reduceChildTranscriptReleaseViewport<S extends ChildSessionStore>(
  state: S,
  action: { parentAppSessionId: string; childSessionId: string },
): S {
  if (
    state.activeAppSessionId !== action.parentAppSessionId ||
    state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
    state.selectedChild.childSessionId !== action.childSessionId
  ) {
    return state;
  }
  const history = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
  if (!history?.isLoaded || !history.isViewportPinned) return state;
  const child = state.childSessions[action.parentAppSessionId]?.[action.childSessionId];
  const runtime = state.childRuntime[action.parentAppSessionId]?.[action.childSessionId];
  if (child?.status === 'running' && runtime?.available) return state;
  return releaseSessionChildTranscriptWindow(
    state,
    action.parentAppSessionId,
    action.childSessionId,
    VIEWPORT_TRANSCRIPT_POLICY,
  );
}

export function reduceSelectChild<S extends ChildSessionStore>(
  state: S,
  action: { selection: ChildSelection | null; requestId?: string },
): S {
  const previous = state.selectedChild;
  let next =
    previous &&
    (action.selection?.parentAppSessionId !== previous.parentAppSessionId ||
      action.selection.childSessionId !== previous.childSessionId)
      ? invalidateSelectedChildOpening(releaseInactiveSelectedChild(state))
      : state;
  if (!action.selection) return { ...next, selectedChild: null };
  const { parentAppSessionId, childSessionId } = action.selection;
  if (
    next.activeAppSessionId !== parentAppSessionId ||
    !next.childSessions[parentAppSessionId]?.[childSessionId]
  )
    return { ...next, selectedChild: null };
  next = { ...next, selectedChild: action.selection };
  if (action.requestId) {
    const opening = withChildAccess(next, parentAppSessionId, childSessionId, {
      state: 'opening',
      requestId: action.requestId,
    });
    const history = opening.childHistory[parentAppSessionId]?.[childSessionId];
    if (history?.isLoaded) return opening;
    const loadedCount = (opening.transcripts[parentAppSessionId] ?? []).filter(
      (event) => event.sourceSessionId === childSessionId,
    ).length;
    return withChildHistory(opening, parentAppSessionId, childSessionId, {
      status: 'loading',
      loadedCount,
      hasMore: false,
      isLoaded: false,
      isLoadingOlder: false,
      isViewportPinned: history?.isViewportPinned ?? true,
    });
  }
  const access = next.childAccess[parentAppSessionId]?.[childSessionId];
  return access?.state === 'failed' || access?.state === 'closed'
    ? withoutChildAccess(next, parentAppSessionId, childSessionId)
    : next;
}

import type { TranscriptEvent } from '../types/bridge';
import { appendTranscriptEvents } from '../lib/transcriptStoreMemory';
import {
  aggregateTranscriptMutationBatch,
  observeTranscriptMutationChanges,
  type TranscriptMutation,
} from '../lib/transcriptMutation';
import type { AppState } from './useStore';

interface TranscriptAction {
  type: 'SESSION_TRANSCRIPT';
  event: TranscriptEvent;
}

export function reduceStoreActionBatch<Action extends { type: string }>(
  state: AppState,
  actions: readonly Action[],
  reduceAction: (state: AppState, action: Action) => AppState,
  syncBrowserState: (state: AppState) => AppState,
): AppState {
  let next = state;
  let pendingTranscriptEvents: TranscriptEvent[] = [];
  const mutationRecords = new Map<string, TranscriptMutation[]>();

  const apply = (updated: AppState): void => {
    observeTranscriptMutationChanges(
      mutationRecords,
      next.transcriptMutations,
      updated.transcriptMutations,
    );
    next = updated;
  };

  const flushTranscriptEvents = (): void => {
    if (pendingTranscriptEvents.length === 0) return;
    apply(syncBrowserState(appendTranscriptEvents(next, pendingTranscriptEvents)));
    pendingTranscriptEvents = [];
  };

  for (const action of actions) {
    if (isTranscriptAction(action)) {
      pendingTranscriptEvents.push(action.event);
      continue;
    }
    flushTranscriptEvents();
    apply(reduceAction(next, action));
  }
  flushTranscriptEvents();

  const transcriptMutations = aggregateTranscriptMutationBatch(
    state.transcriptMutations,
    next.transcriptMutations,
    mutationRecords,
  );
  return transcriptMutations === next.transcriptMutations ? next : { ...next, transcriptMutations };
}

function isTranscriptAction<Action extends { type: string }>(
  action: Action,
): action is Action & TranscriptAction {
  return action.type === 'SESSION_TRANSCRIPT';
}

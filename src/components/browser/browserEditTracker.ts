import { isEditTool } from '../../lib/diff';
import type { TranscriptMutation } from '../../lib/transcriptMutation';
import type { TranscriptEvent } from '../../types/bridge';

export function createBrowserEditTracker() {
  const pending = new Set<string>();
  let previous: readonly TranscriptEvent[] | undefined;
  let previousRevision = 0;

  return (
    events: readonly TranscriptEvent[],
    mutation: TranscriptMutation | undefined,
  ): boolean => {
    if (events === previous) return false;
    const hasAppendLineage = followsAppend(previous, previousRevision, mutation);
    // React can skip intermediate store revisions. Recover from the retained
    // event identities only on that slow path, never on ordinary tail updates.
    const isAppend =
      hasAppendLineage || (mutation?.kind === 'append' && retainsPreviousEvents(previous, events));
    const firstChangedIndex = hasAppendLineage ? mutation.firstChangedIndex : 0;
    const firstNewIndex = previous?.length ?? events.length;
    if (!isAppend) pending.clear();
    let completedEdit = false;
    for (let index = firstChangedIndex; index < events.length; index += 1) {
      if (completesPendingEdit(events[index], pending) && isAppend && index >= firstNewIndex)
        completedEdit = true;
    }
    previous = events;
    previousRevision = mutation?.revision ?? 0;
    return completedEdit;
  };
}

function completesPendingEdit(event: TranscriptEvent, pending: Set<string>): boolean {
  if (event.kind !== 'tool_call' && event.kind !== 'tool_result') return false;
  const key = JSON.stringify([event.sourceSessionId, event.toolUseId ?? '']);
  if (event.kind === 'tool_call') {
    if (isEditTool(event.toolName)) pending.add(key);
    return false;
  }
  return pending.delete(key) && !event.isError;
}

function followsAppend(
  previous: readonly TranscriptEvent[] | undefined,
  revision: number,
  mutation: TranscriptMutation | undefined,
): mutation is TranscriptMutation & { kind: 'append' } {
  return (
    previous !== undefined &&
    mutation?.kind === 'append' &&
    mutation.baseRevision === revision &&
    mutation.previousLength === previous.length
  );
}

function retainsPreviousEvents(
  previous: readonly TranscriptEvent[] | undefined,
  events: readonly TranscriptEvent[],
): boolean {
  return (
    previous !== undefined &&
    events.length >= previous.length &&
    previous.every((event, index) => event.id === events[index].id)
  );
}

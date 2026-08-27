import type { TranscriptEvent } from '../types/bridge';
import type { TranscriptMutation } from './transcriptMutation';

interface SpecPathProjection {
  conversationKey: string;
  source: TranscriptEvent[];
  revision: number;
  eventIndex: number | undefined;
  path: string | null;
}

interface SpecPathInput {
  conversationKey: string;
  source: TranscriptEvent[];
  mutation: TranscriptMutation | undefined;
  enabled: boolean;
}

const SPEC_PATH = /(\/[^\s'"`)]*specs\/[^\s'"`)]+\.md)/;

/** Finds the newest spec path without rescanning settled transcript history. */
export function createTranscriptSpecPathProjector(): (input: SpecPathInput) => string | null {
  let previous: SpecPathProjection | undefined;

  return (input) => {
    if (!input.enabled) {
      previous = undefined;
      return null;
    }
    const revision = input.mutation?.revision ?? 0;
    if (
      previous?.conversationKey === input.conversationKey &&
      previous.source === input.source &&
      previous.revision === revision
    ) {
      return previous.path;
    }

    const incremental = incrementalSpecProjection(previous, input, revision);
    if (incremental) {
      previous = incremental;
      return incremental.path;
    }

    const found = latestSpecPath(input.source, 0, input.source.length);
    previous = {
      conversationKey: input.conversationKey,
      source: input.source,
      revision,
      eventIndex: found?.eventIndex,
      path: found?.path ?? null,
    };
    return previous.path;
  };
}

function incrementalSpecProjection(
  previous: SpecPathProjection | undefined,
  input: SpecPathInput,
  revision: number,
): SpecPathProjection | undefined {
  const mutation = input.mutation;
  if (
    previous?.conversationKey !== input.conversationKey ||
    mutation?.baseRevision !== previous.revision ||
    mutation.previousLength !== previous.source.length
  ) {
    return undefined;
  }
  if (mutation.kind === 'append')
    return appendedSpecProjection(previous, input, revision, mutation);
  if (
    mutation.kind !== 'prepend' ||
    input.source.length !== previous.source.length + mutation.insertedCount
  ) {
    return undefined;
  }
  return prependedSpecProjection(previous, input, revision, mutation);
}

function appendedSpecProjection(
  previous: SpecPathProjection,
  input: SpecPathInput,
  revision: number,
  mutation: Pick<TranscriptMutation, 'firstChangedIndex'>,
): SpecPathProjection | undefined {
  const found = latestSpecPath(input.source, mutation.firstChangedIndex, input.source.length);
  if (!found && (previous.eventIndex ?? -1) >= mutation.firstChangedIndex) return undefined;
  return {
    conversationKey: input.conversationKey,
    source: input.source,
    revision,
    eventIndex: found?.eventIndex ?? previous.eventIndex,
    path: found?.path ?? previous.path,
  };
}

function prependedSpecProjection(
  previous: SpecPathProjection,
  input: SpecPathInput,
  revision: number,
  mutation: Extract<TranscriptMutation, { kind: 'prepend' }>,
): SpecPathProjection {
  const inserted = latestSpecPath(
    input.source,
    mutation.firstChangedIndex,
    mutation.firstChangedIndex + mutation.insertedCount,
  );
  const shiftedPreviousIndex = shiftIndexForInsertion(
    previous.eventIndex,
    mutation.firstChangedIndex,
    mutation.insertedCount,
  );
  const useInserted =
    inserted !== undefined &&
    (shiftedPreviousIndex === undefined || inserted.eventIndex > shiftedPreviousIndex);
  return {
    conversationKey: input.conversationKey,
    source: input.source,
    revision,
    eventIndex: useInserted ? inserted.eventIndex : shiftedPreviousIndex,
    path: useInserted ? inserted.path : previous.path,
  };
}

function shiftIndexForInsertion(
  index: number | undefined,
  insertionIndex: number,
  insertedCount: number,
): number | undefined {
  if (index === undefined) return undefined;
  return index >= insertionIndex ? index + insertedCount : index;
}

function latestSpecPath(
  events: readonly TranscriptEvent[],
  start: number,
  end: number,
): { eventIndex: number; path: string } | undefined {
  for (let eventIndex = end - 1; eventIndex >= start; eventIndex -= 1) {
    const event = events.at(eventIndex);
    if (!event) continue;
    const match = SPEC_PATH.exec(`${event.text ?? ''} ${stringifyToolArgs(event.toolArgs)}`);
    const path = match?.[1];
    if (path !== undefined) return { eventIndex, path };
  }
  return undefined;
}

function stringifyToolArgs(toolArgs: unknown): string {
  if (toolArgs === undefined) return '';
  try {
    return JSON.stringify(toolArgs);
  } catch {
    return '';
  }
}

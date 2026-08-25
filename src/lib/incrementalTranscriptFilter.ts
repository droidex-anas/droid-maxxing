import type { TranscriptEvent } from '../types/bridge';
import {
  asChunkedSequence,
  insertChunkedSequence,
  replaceChunkedSequenceSuffix,
} from './chunkedSequence';
import type { TranscriptMutation } from './transcriptMutation';

interface FilterProjection {
  conversationKey: string;
  source: TranscriptEvent[];
  filtered: TranscriptEvent[];
  revision: number;
}

interface FilterInput {
  conversationKey: string;
  source: TranscriptEvent[];
  mutation: TranscriptMutation | undefined;
  includes: (event: TranscriptEvent) => boolean;
}

/** Projects one transcript subset while reading only a proven changed suffix/page. */
export function createIncrementalTranscriptFilter(): (input: FilterInput) => TranscriptEvent[] {
  let previous: FilterProjection | undefined;

  return (input) => {
    const revision = input.mutation?.revision ?? 0;
    if (
      previous?.conversationKey === input.conversationKey &&
      previous.source === input.source &&
      previous.revision === revision
    ) {
      return previous.filtered;
    }

    const incremental = projectIncrementalFilter(previous, input, revision);
    if (incremental) {
      previous = incremental;
      return incremental.filtered;
    }

    const filtered = asChunkedSequence(input.source.filter(input.includes));
    previous = {
      conversationKey: input.conversationKey,
      source: input.source,
      filtered,
      revision,
    };
    return filtered;
  };
}

function projectIncrementalFilter(
  previous: FilterProjection | undefined,
  input: FilterInput,
  revision: number,
): FilterProjection | undefined {
  const mutation = input.mutation;
  if (
    previous?.conversationKey !== input.conversationKey ||
    mutation?.baseRevision !== previous.revision ||
    mutation.previousLength !== previous.source.length
  ) {
    return undefined;
  }
  if (mutation.kind === 'append') return projectAppendedFilter(previous, input, revision, mutation);
  if (
    mutation.kind === 'prepend' &&
    input.source.length === previous.source.length + mutation.insertedCount
  ) {
    return projectPrependedFilter(previous, input, revision, mutation);
  }
  return undefined;
}

function projectAppendedFilter(
  previous: FilterProjection,
  input: FilterInput,
  revision: number,
  mutation: Pick<TranscriptMutation, 'firstChangedIndex'>,
): FilterProjection {
  let filteredPrefixLength = previous.filtered.length;
  for (let index = mutation.firstChangedIndex; index < previous.source.length; index += 1) {
    const event = previous.source.at(index);
    if (event && input.includes(event)) filteredPrefixLength -= 1;
  }
  const suffix = filterRange(
    input.source,
    mutation.firstChangedIndex,
    input.source.length,
    input.includes,
  );
  return {
    conversationKey: input.conversationKey,
    source: input.source,
    filtered: replaceChunkedSequenceSuffix(previous.filtered, filteredPrefixLength, suffix),
    revision,
  };
}

function projectPrependedFilter(
  previous: FilterProjection,
  input: FilterInput,
  revision: number,
  mutation: Extract<TranscriptMutation, { kind: 'prepend' }>,
): FilterProjection {
  let filteredInsertionIndex = 0;
  for (let index = 0; index < mutation.firstChangedIndex; index += 1) {
    const event = previous.source.at(index);
    if (event && input.includes(event)) filteredInsertionIndex += 1;
  }
  const inserted = filterRange(
    input.source,
    mutation.firstChangedIndex,
    mutation.firstChangedIndex + mutation.insertedCount,
    input.includes,
  );
  return {
    conversationKey: input.conversationKey,
    source: input.source,
    filtered: insertChunkedSequence(previous.filtered, filteredInsertionIndex, inserted),
    revision,
  };
}

function filterRange(
  source: readonly TranscriptEvent[],
  start: number,
  end: number,
  includes: (event: TranscriptEvent) => boolean,
): TranscriptEvent[] {
  const filtered: TranscriptEvent[] = [];
  for (let index = start; index < end; index += 1) {
    const event = source.at(index);
    if (event && includes(event)) filtered.push(event);
  }
  return filtered;
}

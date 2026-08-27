interface TranscriptMutationBase {
  previousLength: number;
  firstChangedIndex: number;
}

export type TranscriptMutationChange =
  | (TranscriptMutationBase & { kind: 'append' | 'reset' })
  | (TranscriptMutationBase & { kind: 'prepend'; insertedCount: number });

export type TranscriptMutation = TranscriptMutationChange & {
  revision: number;
  baseRevision: number;
};

export function detectPureTranscriptPrepend<T>(
  previous: readonly T[],
  next: readonly T[],
): TranscriptMutationChange | undefined {
  const insertedCount = next.length - previous.length;
  if (previous.length === 0 || insertedCount <= 0) return undefined;

  let firstChangedIndex = 0;
  while (
    firstChangedIndex < previous.length &&
    next[firstChangedIndex] === previous[firstChangedIndex]
  ) {
    firstChangedIndex += 1;
  }
  // A tail insertion is ordinary append provenance, not older-history prepend.
  if (firstChangedIndex === previous.length) return undefined;

  for (let index = firstChangedIndex; index < previous.length; index += 1) {
    if (next[index + insertedCount] !== previous[index]) return undefined;
  }

  return {
    kind: 'prepend',
    previousLength: previous.length,
    firstChangedIndex,
    insertedCount,
  };
}

export function nextTranscriptMutation(
  previous: TranscriptMutation | undefined,
  change: TranscriptMutationChange,
): TranscriptMutation {
  if (previous !== undefined) validateMutation(previous);
  validateChange(change);

  const baseRevision = previous?.revision ?? 0;
  const revision = baseRevision + 1;
  validateRevision('revision', revision);

  return {
    revision,
    baseRevision,
    ...change,
  };
}

export function aggregateTranscriptMutations(
  batchStartRevision: number,
  records: readonly TranscriptMutation[],
): TranscriptMutation | undefined {
  validateRevision('batchStartRevision', batchStartRevision);
  if (records.length === 0) return undefined;
  const first = records.at(0);
  if (!first) return undefined;

  let expectedBaseRevision = batchStartRevision;
  let finalBaseRevision = batchStartRevision;
  let finalRevision = batchStartRevision;
  let firstChangedIndex = first.firstChangedIndex;
  const preservedPrepend =
    records.length === 1 && first.kind === 'prepend' && first.baseRevision === batchStartRevision
      ? first
      : undefined;
  let requiresReset = false;

  for (const record of records) {
    validateMutation(record);
    if (mutationBreaksBatchLineage(record, preservedPrepend, expectedBaseRevision)) {
      requiresReset = true;
    }
    firstChangedIndex = Math.min(firstChangedIndex, record.firstChangedIndex);
    expectedBaseRevision = record.revision;
    finalBaseRevision = record.baseRevision;
    finalRevision = record.revision;
  }

  // A pruned session can restart its mutation lineage at revision one while
  // the current batch still remembers the old lineage. Keep the new record's
  // valid revision pair so downstream projectors detect the mismatch.
  const baseRevision = finalRevision <= batchStartRevision ? finalBaseRevision : batchStartRevision;

  if (preservedPrepend && !requiresReset) {
    return {
      revision: finalRevision,
      baseRevision,
      kind: 'prepend',
      previousLength: preservedPrepend.previousLength,
      firstChangedIndex: preservedPrepend.firstChangedIndex,
      insertedCount: preservedPrepend.insertedCount,
    };
  }

  return {
    revision: finalRevision,
    baseRevision,
    kind: requiresReset ? 'reset' : 'append',
    previousLength: first.previousLength,
    firstChangedIndex: requiresReset ? 0 : firstChangedIndex,
  };
}

function mutationBreaksBatchLineage(
  record: TranscriptMutation,
  preservedPrepend: TranscriptMutation | undefined,
  expectedBaseRevision: number,
): boolean {
  return (
    record.kind === 'reset' ||
    (record.kind === 'prepend' && !preservedPrepend) ||
    record.baseRevision !== expectedBaseRevision
  );
}

export function observeTranscriptMutationChanges(
  records: Map<string, TranscriptMutation[]>,
  before: Readonly<Record<string, TranscriptMutation>>,
  after: Readonly<Record<string, TranscriptMutation>>,
): void {
  if (before === after) return;

  for (const [appSessionId, mutation] of Object.entries(after)) {
    if (before[appSessionId] === mutation) continue;
    const observed = records.get(appSessionId);
    if (observed) observed.push(mutation);
    else records.set(appSessionId, [mutation]);
  }
}

export function aggregateTranscriptMutationBatch(
  batchStart: Readonly<Record<string, TranscriptMutation>>,
  final: Record<string, TranscriptMutation>,
  records: ReadonlyMap<string, readonly TranscriptMutation[]>,
): Record<string, TranscriptMutation> {
  let result: Record<string, TranscriptMutation> | undefined;

  for (const [appSessionId, observed] of records) {
    if (!Object.hasOwn(final, appSessionId)) continue;
    const batchStartRevision = batchStart[appSessionId]?.revision ?? 0;
    const aggregate = aggregateTranscriptMutations(batchStartRevision, observed);
    if (aggregate === undefined) continue;

    result ??= { ...final };
    result[appSessionId] = aggregate;
  }

  return result ?? final;
}

function validateMutation(mutation: TranscriptMutation): void {
  validateRevision('revision', mutation.revision);
  validateRevision('baseRevision', mutation.baseRevision);
  if (mutation.revision <= mutation.baseRevision) {
    throw new RangeError('Transcript mutation revision must be greater than its base revision.');
  }
  validateChange(mutation);
}

function validateChange(change: TranscriptMutationChange): void {
  validateIndex('previousLength', change.previousLength);
  validateIndex('firstChangedIndex', change.firstChangedIndex);
  if (change.firstChangedIndex > change.previousLength) {
    throw new RangeError('Transcript mutation firstChangedIndex cannot exceed its previousLength.');
  }
  if (change.kind === 'prepend') {
    validateIndex('insertedCount', change.insertedCount);
    if (change.insertedCount === 0) {
      throw new RangeError('Transcript mutation insertedCount must be greater than zero.');
    }
  }
}

function validateIndex(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Transcript mutation ${name} must be a non-negative safe integer.`);
  }
}

function validateRevision(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Transcript mutation ${name} must be a non-negative safe integer.`);
  }
}

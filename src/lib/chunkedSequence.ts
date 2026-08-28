const DEFAULT_CHUNK_SIZE = 128;

interface ChunkedSequenceState<T> {
  settledChunks: readonly (readonly T[])[];
  settledEnds: readonly number[];
  settledLength: number;
  liveChunk: readonly T[];
  chunkSize: number;
}

const sequenceStates = new WeakMap<readonly unknown[], ChunkedSequenceState<unknown>>();
const mutatingMethods = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

export function asChunkedSequence<T>(values: readonly T[], chunkSize = DEFAULT_CHUNK_SIZE): T[] {
  validateChunkSize(chunkSize);
  const existing = getSequenceState(values);
  if (existing?.chunkSize === chunkSize) return values as T[];
  if (values.length === 0) return createSequence(emptyState<T>(chunkSize));

  const chunks: (readonly T[])[] = [];
  let chunk: T[] = [];
  for (const value of values) {
    chunk.push(value);
    if (chunk.length !== chunkSize) continue;
    chunks.push(chunk);
    chunk = [];
  }
  if (chunk.length > 0) chunks.push(chunk);
  return createSequence(stateFromChunks(chunks, chunkSize));
}

/**
 * Derived operations resolve an existing sequence before normalization so its
 * chunk geometry survives: renormalizing a custom-sized sequence would copy
 * every retained chunk and break reference-based render memoization.
 */
function resolveChunkedSequence<T>(values: readonly T[]): T[] {
  return getSequenceState(values) ? (values as T[]) : asChunkedSequence(values);
}

export function replaceChunkedSequenceSuffix<T>(
  values: readonly T[],
  start: number,
  replacement: readonly T[],
): T[] {
  validateIndex('start', start, values.length);
  const sequence = resolveChunkedSequence(values);
  const state = requiredSequenceState(sequence);

  if (start >= state.settledLength) {
    const livePrefixLength = start - state.settledLength;
    const live = state.liveChunk.slice(0, livePrefixLength).concat(replacement);
    return createSequence(normalizeLiveChunk(state, live));
  }

  const prefixChunks = chunksForRange(state, 0, start);
  const replacementChunks = chunksFromValues(replacement, state.chunkSize);
  return createSequence(stateFromChunks([...prefixChunks, ...replacementChunks], state.chunkSize));
}

export function insertChunkedSequence<T>(
  values: readonly T[],
  index: number,
  inserted: readonly T[],
): T[] {
  validateIndex('index', index, values.length);
  if (inserted.length === 0) return values as T[];
  const sequence = resolveChunkedSequence(values);
  const state = requiredSequenceState(sequence);
  const chunks = [
    ...chunksForRange(state, 0, index),
    ...chunksFromValues(inserted, state.chunkSize),
    ...chunksForRange(state, index, sequence.length),
  ];
  return createSequence(stateFromChunks(chunks, state.chunkSize));
}

export function replaceChunkedSequencePrefix<T>(
  values: readonly T[],
  end: number,
  replacement: readonly T[],
): T[] {
  validateIndex('end', end, values.length);
  const sequence = resolveChunkedSequence(values);
  const state = requiredSequenceState(sequence);
  return createSequence(
    stateFromChunks(
      [
        ...chunksFromValues(replacement, state.chunkSize),
        ...chunksForRange(state, end, sequence.length),
      ],
      state.chunkSize,
    ),
  );
}

export function chunkedSequenceSlice<T>(values: readonly T[], start = 0, end = values.length): T[] {
  const sequence = resolveChunkedSequence(values);
  const state = requiredSequenceState(sequence);
  const normalizedStart = normalizeSliceIndex(start, sequence.length);
  const normalizedEnd = Math.max(normalizedStart, normalizeSliceIndex(end, sequence.length));
  return createSequence(
    stateFromChunks(chunksForRange(state, normalizedStart, normalizedEnd), state.chunkSize),
  );
}

export function chunkedSequenceDiagnostics(values: readonly unknown[]): {
  settledChunkCount: number;
  settledEventCount: number;
  liveEventCount: number;
} {
  const sequence = resolveChunkedSequence(values);
  const state = requiredSequenceState(sequence);
  return {
    settledChunkCount: state.settledChunks.length,
    settledEventCount: state.settledLength,
    liveEventCount: state.liveChunk.length,
  };
}

export function chunkedSequenceChunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const sequence = resolveChunkedSequence(values);
  const state = requiredSequenceState(sequence);
  return state.liveChunk.length > 0
    ? [...state.settledChunks, state.liveChunk]
    : state.settledChunks;
}

function normalizeLiveChunk<T>(state: ChunkedSequenceState<T>, live: readonly T[]) {
  if (live.length <= state.chunkSize) return { ...state, liveChunk: live };

  const addedSettled = chunksFromValues(
    live.slice(0, live.length - (live.length % state.chunkSize || state.chunkSize)),
    state.chunkSize,
  );
  const nextLive = live.slice(addedSettled.length * state.chunkSize);
  return stateFromChunks(
    [...state.settledChunks, ...addedSettled, ...(nextLive.length > 0 ? [nextLive] : [])],
    state.chunkSize,
  );
}

function chunksFromValues<T>(values: readonly T[], chunkSize: number): (readonly T[])[] {
  const chunks: (readonly T[])[] = [];
  for (let start = 0; start < values.length; start += chunkSize) {
    chunks.push(values.slice(start, Math.min(values.length, start + chunkSize)));
  }
  return chunks;
}

function chunksForRange<T>(
  state: ChunkedSequenceState<T>,
  start: number,
  end: number,
): (readonly T[])[] {
  if (start >= end) return [];
  const chunks = [...state.settledChunks, state.liveChunk];
  const selected: (readonly T[])[] = [];
  let chunkStart = 0;
  for (const chunk of chunks) {
    const chunkEnd = chunkStart + chunk.length;
    if (chunkEnd <= start) {
      chunkStart = chunkEnd;
      continue;
    }
    if (chunkStart >= end) break;
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(chunk.length, end - chunkStart);
    selected.push(from === 0 && to === chunk.length ? chunk : chunk.slice(from, to));
    chunkStart = chunkEnd;
  }
  return selected;
}

function stateFromChunks<T>(
  source: readonly (readonly T[])[],
  chunkSize: number,
): ChunkedSequenceState<T> {
  const chunks = source.filter((chunk) => chunk.length > 0);
  if (chunks.length === 0) return emptyState(chunkSize);
  const settledChunks = chunks.slice(0, -1);
  const liveChunk = chunks.at(-1);
  if (!liveChunk) return emptyState(chunkSize);
  const settledEnds: number[] = [];
  let settledLength = 0;
  for (const chunk of settledChunks) {
    settledLength += chunk.length;
    settledEnds.push(settledLength);
  }
  return { settledChunks, settledEnds, settledLength, liveChunk, chunkSize };
}

function emptyState<T>(chunkSize: number): ChunkedSequenceState<T> {
  return {
    settledChunks: [],
    settledEnds: [],
    settledLength: 0,
    liveChunk: [],
    chunkSize,
  };
}

function createSequence<T>(state: ChunkedSequenceState<T>): T[] {
  const length = state.settledLength + state.liveChunk.length;
  const target = new Array<T>(length);
  const proxy = new Proxy(target, {
    get(_target, property, receiver) {
      if (property === Symbol.iterator) return () => sequenceIterator(state);
      if (property === 'at')
        return (index: number) => eventAt(state, normalizeAtIndex(index, length));
      if (property === 'slice') {
        return (start?: number, end?: number) =>
          chunkedSequenceSlice(proxy, start ?? 0, end ?? length);
      }
      if (typeof property === 'string' && mutatingMethods.has(property)) {
        return () => {
          throw new TypeError('Chunked sequences are immutable.');
        };
      }
      const index = arrayIndex(property);
      if (index !== undefined) return eventAt(state, index);
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
    set() {
      throw new TypeError('Chunked sequences are immutable.');
    },
    deleteProperty() {
      throw new TypeError('Chunked sequences are immutable.');
    },
    has(targetValue, property) {
      const index = arrayIndex(property);
      return index === undefined ? Reflect.has(targetValue, property) : index < length;
    },
    ownKeys() {
      const keys = Array.from({ length }, (_, index) => String(index));
      keys.push('length');
      return keys;
    },
    getOwnPropertyDescriptor(targetValue, property) {
      const index = arrayIndex(property);
      if (index === undefined) return Reflect.getOwnPropertyDescriptor(targetValue, property);
      if (index >= length) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: eventAt(state, index),
        writable: false,
      };
    },
  });
  sequenceStates.set(proxy, state);
  return proxy;
}

function* sequenceIterator<T>(state: ChunkedSequenceState<T>): IterableIterator<T> {
  for (const chunk of state.settledChunks) yield* chunk;
  yield* state.liveChunk;
}

function eventAt<T>(state: ChunkedSequenceState<T>, index: number): T | undefined {
  if (index < 0 || index >= state.settledLength + state.liveChunk.length) return undefined;
  if (index >= state.settledLength) return state.liveChunk[index - state.settledLength];

  let low = 0;
  let high = state.settledEnds.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleEnd = state.settledEnds.at(middle);
    if (middleEnd === undefined) throw new TypeError('Invalid chunked-sequence index state.');
    if (index < middleEnd) high = middle;
    else low = middle + 1;
  }
  const chunkStart = low === 0 ? 0 : state.settledEnds.at(low - 1);
  const chunk = state.settledChunks.at(low);
  if (chunkStart === undefined || !chunk) {
    throw new TypeError('Invalid chunked-sequence index state.');
  }
  return chunk[index - chunkStart];
}

function getSequenceState<T>(values: readonly T[]): ChunkedSequenceState<T> | undefined {
  return sequenceStates.get(values) as ChunkedSequenceState<T> | undefined;
}

function requiredSequenceState<T>(values: readonly T[]): ChunkedSequenceState<T> {
  const state = getSequenceState(values);
  if (!state) throw new TypeError('Expected an initialized chunked sequence.');
  return state;
}

function arrayIndex(property: string | symbol): number | undefined {
  if (typeof property !== 'string' || !/^(?:0|[1-9]\d*)$/.test(property)) return undefined;
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : undefined;
}

function normalizeAtIndex(index: number, length: number): number {
  if (!Number.isInteger(index)) return -1;
  return index < 0 ? length + index : index;
}

function normalizeSliceIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return index < 0 ? 0 : length;
  const integer = Math.trunc(index);
  return integer < 0 ? Math.max(0, length + integer) : Math.min(length, integer);
}

function validateIndex(name: string, value: number, length: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new RangeError(`${name} must be a safe index within the sequence.`);
  }
}

function validateChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 2) {
    throw new RangeError('chunkSize must be an integer greater than one.');
  }
}

import type { StreamFidelity } from './protocol.js';

export const CHILD_TOKEN_STREAM_OPTIONS = { includePartialMessages: true } as const;

export function childTokenStream(): {
  options: typeof CHILD_TOKEN_STREAM_OPTIONS;
  fidelity: 'token';
} {
  return { options: CHILD_TOKEN_STREAM_OPTIONS, fidelity: 'token' };
}

export function observedChildStreamFidelity(): StreamFidelity {
  return 'state';
}

export function publishedStreamFidelity(declared: StreamFidelity | undefined): StreamFidelity {
  return declared ?? observedChildStreamFidelity();
}

export function isStreamFidelity(value: unknown): value is StreamFidelity {
  return value === 'token' || value === 'tool' || value === 'state';
}

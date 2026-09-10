import type { BrowserState } from './types.js';

const INITIAL_POLL_MS = 250;
const MAX_POLL_MS = 1_000;
const MAX_SNAPSHOTS = 20;

export async function waitForBrowserCondition(options: {
  input: { text?: string; ref?: string; urlIncludes?: string; timeoutMs?: number };
  snapshot: () => Promise<BrowserState>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<BrowserState> {
  const timeoutMs = Math.min(15_000, Math.max(0, options.input.timeoutMs ?? 5_000));
  const now = options.now ?? Date.now;
  const wait = options.delay ?? delay;
  if (!options.input.text && !options.input.ref && !options.input.urlIncludes) {
    await wait(timeoutMs);
    return options.snapshot();
  }
  const deadline = now() + timeoutMs;
  let state = await options.snapshot();
  let snapshotCount = 1;
  let pollIntervalMs = INITIAL_POLL_MS;
  while (!matches(state, options.input) && snapshotCount < MAX_SNAPSHOTS) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(pollIntervalMs, remainingMs));
    state = await options.snapshot();
    snapshotCount += 1;
    pollIntervalMs = Math.min(MAX_POLL_MS, pollIntervalMs * 2);
  }
  if (!matches(state, options.input)) {
    const { text, ref, urlIncludes } = options.input;
    const conditions = [
      text ? `text ${JSON.stringify(text)}` : undefined,
      ref ? `ref ${ref}` : undefined,
      urlIncludes ? `url containing ${JSON.stringify(urlIncludes)}` : undefined,
    ].filter((condition) => condition !== undefined);
    throw new Error(
      `Timed out waiting for the browser condition: ${conditions.join(', ')}. Current URL: ${state.url}`,
    );
  }
  return state;
}

function matches(
  state: BrowserState,
  input: { text?: string; ref?: string; urlIncludes?: string },
): boolean {
  if (input.urlIncludes && !state.url.includes(input.urlIncludes)) return false;
  if (input.ref && !state.refs.some((item) => item.ref === input.ref)) return false;
  if (!input.text) return true;
  const expected = input.text.toLowerCase();
  return state.refs.some(
    (item) =>
      (item.text ?? '').toLowerCase().includes(expected) ||
      (item.name ?? '').toLowerCase().includes(expected),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { hasCompleteAppBlock } from './appBlockRuntime';
import type { FeedItem } from './chatFeed';
import type { TranscriptEvent } from '../types/bridge';

export interface FinalResponseKeyState {
  identity: string;
  latestPromptEvent: TranscriptEvent | undefined;
  settledKeys: ReadonlySet<string>;
  liveKeys: ReadonlySet<string>;
}

/** Keeps completed-turn response keys stable while only re-reading the live turn. */
export function projectFinalResponseKeys(
  previous: FinalResponseKeyState | null,
  identity: string,
  items: FeedItem[],
  updateKind: 'full' | 'append' | 'prepend',
): FinalResponseKeyState {
  const { index: latestPromptIndex, event: latestPromptEvent } = latestPrompt(items);
  const projectedLiveKeys = finalResponseKeysInRange(items, latestPromptIndex + 1);
  const liveKeys = reuseLiveKeys(previous, identity, projectedLiveKeys);

  if (previous?.identity === identity && updateKind === 'append') {
    if (previous.latestPromptEvent === latestPromptEvent) {
      return { ...previous, liveKeys };
    }
    const settledKeys = new Set(previous.settledKeys);
    for (const key of previous.liveKeys) settledKeys.add(key);
    return { identity, latestPromptEvent, settledKeys, liveKeys };
  }

  const settledKeys = new Set<string>();
  let pendingKey: string | undefined;
  for (let index = 0; index < latestPromptIndex; index += 1) {
    const item = items.at(index);
    if (!item) continue;
    if (item.type === 'message' && item.event.author === 'user') {
      if (pendingKey) settledKeys.add(pendingKey);
      pendingKey = undefined;
    } else if (item.type === 'message' && item.event.author !== 'user') {
      pendingKey = item.key;
    }
  }
  if (pendingKey) settledKeys.add(pendingKey);
  return { identity, latestPromptEvent, settledKeys, liveKeys };
}

function reuseLiveKeys(
  previous: FinalResponseKeyState | null,
  identity: string,
  next: ReadonlySet<string>,
): ReadonlySet<string> {
  return previous?.identity === identity ? stableLiveKeys(previous.liveKeys, next) : next;
}

// The live set is at most one key; reuse the previous reference when its
// content is unchanged so chunk memoization can compare it by identity.
function stableLiveKeys(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): ReadonlySet<string> {
  if (previous.size !== next.size) return next;
  for (const key of next) {
    if (!previous.has(key)) return next;
  }
  return previous;
}

function finalResponseKeysInRange(items: FeedItem[], start: number): ReadonlySet<string> {
  let finalKey: string | undefined;
  for (let index = Math.max(0, start); index < items.length; index += 1) {
    const item = items.at(index);
    if (!item) continue;
    if (item.type === 'message' && item.event.author !== 'user') finalKey = item.key;
  }
  return finalKey ? new Set([finalKey]) : new Set();
}

// Only genuinely appended items animate in. A prepend encounters an existing
// tail key immediately and therefore leaves every historical row still.
export function appendedFeedItemKeys(
  items: readonly { key: string }[],
  previous: { identity: string; keys: Set<string> } | null,
  identity: string,
): Set<string> {
  const appended = new Set<string>();
  if (previous?.identity !== identity) return appended;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const key = items.at(index)?.key;
    if (key === undefined) continue;
    if (previous.keys.has(key)) break;
    appended.add(key);
  }
  return appended;
}

export function appendedFeedItemKeysFromProjection(
  items: readonly { key: string }[],
  previous: { identity: string; items: readonly { key: string }[] } | null,
  identity: string,
  updateKind: 'full' | 'append' | 'prepend',
  rebuiltFromItemIndex: number,
): Set<string> {
  const appended = new Set<string>();
  if (previous?.identity !== identity || updateKind !== 'append') return appended;
  const start = Math.max(0, Math.min(rebuiltFromItemIndex, items.length, previous.items.length));
  const previousSuffixKeys = new Set<string>();
  for (let index = start; index < previous.items.length; index += 1) {
    const key = previous.items.at(index)?.key;
    if (key !== undefined) previousSuffixKeys.add(key);
  }
  for (let index = items.length - 1; index >= start; index -= 1) {
    const key = items.at(index)?.key;
    if (key === undefined) continue;
    if (previousSuffixKeys.has(key)) break;
    appended.add(key);
  }
  return appended;
}

export interface FreshAppResponseState {
  identity: string;
  wasPending: boolean;
  texts: Set<string>;
}

export function completeAppResponsesInLatestTurn(items: FeedItem[]): string[] {
  const latestPromptIndex = latestPrompt(items).index;
  if (latestPromptIndex < 0) return [];

  const responses: string[] = [];
  for (let index = latestPromptIndex + 1; index < items.length; index += 1) {
    const item = items.at(index);
    if (!item) continue;
    if (item.type !== 'message' || item.event.author === 'user') continue;
    const text = item.event.text ?? '';
    if (hasCompleteAppBlock(text)) responses.push(text);
  }
  return responses;
}

function latestPrompt(items: readonly FeedItem[]): {
  index: number;
  event: TranscriptEvent | undefined;
} {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items.at(index);
    if (!item) continue;
    if (item.type === 'message' && item.event.author === 'user') {
      return { index, event: item.event };
    }
  }
  return { index: -1, event: undefined };
}

export function rememberFreshAppResponses(
  previous: FreshAppResponseState | null,
  identity: string,
  items: FeedItem[],
  pending: boolean,
): FreshAppResponseState {
  const sameSession = previous?.identity === identity;
  const texts = new Set(sameSession ? previous.texts : []);
  const justSettled = sameSession && previous.wasPending && !pending;

  if (pending || justSettled) {
    for (const text of completeAppResponsesInLatestTurn(items)) texts.add(text);
  }

  return { identity, wasPending: pending, texts };
}

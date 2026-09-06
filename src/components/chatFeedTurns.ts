import { feedItemTailId } from '../hooks/conversationViewportAnchor';
import { classifyEvent } from '../lib/transcript';
import { isSubagentBookkeepingTool } from '../lib/tools';
import type { TranscriptEvent } from '../types/bridge';
import {
  buildFeed,
  collectTurnFiles,
  isCancellationArtifact,
  isCompactionCompleteStatus,
  type BuildFeedOptions,
  type FeedItem,
} from './chatFeed';

function isUserMessage(item: FeedItem): boolean {
  return item.type === 'message' && item.event.author === 'user';
}

// Short preview of a message for the conversation timeline tooltip: whitespace
// (including newlines) is collapsed to single spaces so the hover reads as one
// flowing horizontal snippet, capped in length so a large prompt can't produce
// a huge tooltip.
function turnLabel(text?: string): string {
  if (!text) return 'Message';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Message';
  return clean.length > 160 ? `${clean.slice(0, 160).trimEnd()}…` : clean;
}

export interface ConversationAnchor {
  id: string;
  label: string;
}

// One anchor per turn: the turn's final model response (its summary). The id is
// the feed item key, which MessageFeed also stamps onto the rendered row so the
// timeline can scroll to it.
export function finalResponseAnchorsFromItems(items: FeedItem[]): ConversationAnchor[] {
  const out: ConversationAnchor[] = [];
  let pendingKey: string | null = null;
  let pendingText: string | undefined;
  const flush = () => {
    if (pendingKey !== null) out.push({ id: pendingKey, label: turnLabel(pendingText) });
    pendingKey = null;
    pendingText = undefined;
  };
  for (const it of items) {
    if (isUserMessage(it)) {
      flush();
    } else if (it.type === 'message' && it.event.author !== 'user') {
      pendingKey = it.key;
      pendingText = it.event.text;
    }
  }
  flush();
  return out;
}

// One anchor per user prompt for the conversation timeline: the dot previews the
// prompt text and scrolls that prompt to the top. Anchoring on prompts keeps the
// dot count exactly equal to the number of prompts (a leading model/spec message
// no longer adds a stray dot) and lets the hover preview show what was asked.
export function promptAnchorsFromItems(items: FeedItem[]): ConversationAnchor[] {
  const out: ConversationAnchor[] = [];
  for (const it of items) {
    if (it.type === 'message' && it.event.author === 'user') {
      out.push({ id: it.key, label: turnLabel(it.event.text) });
    }
  }
  return out;
}

// The subagent poll call the transcript currently ends on, if any. The dock
// suppresses these calls (the wave card speaks for them), so the tail the user
// sees is an earlier, already-finished step: without this the feed shimmers a
// settled row while the parent's real work — checking on its subagents — goes
// unannounced. Returning the call also lets the cue time the check itself.
export function trailingSubagentPoll(
  events: TranscriptEvent[],
  grouped: boolean,
): TranscriptEvent | undefined {
  if (!grouped) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (isCancellationArtifact(e)) continue;
    if (e.kind === 'tool_call') return isSubagentBookkeepingTool(e.toolName) ? e : undefined;
    if (e.kind !== 'tool_result' || !e.toolUseId) return undefined;
    // A replayed result carries no toolName, so correlate it back to its call —
    // scanning backward from the result, since the call is always just behind it
    // and a forward scan would walk the whole transcript on every render.
    for (let j = i - 1; j >= 0; j--) {
      const call = events[j];
      if (call.kind !== 'tool_call' || call.toolUseId !== e.toolUseId) continue;
      return isSubagentBookkeepingTool(call.toolName) ? call : undefined;
    }
    return undefined;
  }
  return undefined;
}

// Build the grouped feed once so callers can share it (the chat view derives
// timeline anchors from the same items it hands to MessageFeed, instead of
// running buildFeed/groupTurns a second time on every render and switch).
export type GroupedFeedOptions = BuildFeedOptions & {
  specContent?: string;
  changes?: boolean;
};

export function buildGroupedFeed(
  events: TranscriptEvent[],
  pending: boolean,
  { specContent, changes = false, ...feedOptions }: GroupedFeedOptions = {},
): FeedItem[] {
  return groupTurns(buildFeed(events, feedOptions), pending, specContent, changes);
}

// Public helper so the chat view can derive the same anchors MessageFeed stamps.
export function conversationAnchors(
  events: TranscriptEvent[],
  pending: boolean,
  options?: GroupedFeedOptions,
): ConversationAnchor[] {
  return promptAnchorsFromItems(buildGroupedFeed(events, pending, options));
}

// Best-effort end timestamp of a feed item, used to time the live working cue.
export function tailTimestamp(item?: FeedItem): number | undefined {
  if (!item) return undefined;
  if (item.type === 'worked' || item.type === 'turnChanges') return undefined;
  if (item.type === 'tools') {
    const e = item.events[item.events.length - 1];
    return e?.endTs ?? e?.ts;
  }
  if (item.type === 'diffs') {
    const c = item.changes[item.changes.length - 1];
    return c?.event.endTs ?? c?.event.ts;
  }
  if (item.type === 'child_sessions') {
    const e = item.events.at(-1);
    return e?.endTs ?? e?.ts;
  }
  return item.event.endTs ?? item.event.ts;
}

// Earliest start and latest end timestamps across a set of feed items.
function spanOf(items: FeedItem[]): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  const consider = (ts?: number, endTs?: number) => {
    if (ts == null) return;
    start = Math.min(start, ts);
    end = Math.max(end, endTs ?? ts);
  };
  for (const it of items) {
    if (it.type === 'tools')
      it.events.forEach((e) => {
        consider(e.ts, e.endTs);
      });
    else if (it.type === 'diffs')
      it.changes.forEach((c) => {
        consider(c.event.ts, c.event.endTs);
      });
    else if (it.type === 'child_sessions')
      it.events.forEach((e) => {
        consider(e.ts, e.endTs);
      });
    else if (it.type !== 'worked' && it.type !== 'turnChanges')
      consider(it.event.ts, it.event.endTs);
  }
  if (start === Infinity) return { start: 0, end: 0 };
  return { start, end };
}

// A folded activity item that is purely todo/plan reconciliation (no real tool
// work). Used to decide whether two assistant text fragments are actually one
// final answer split by an internal checklist update. The group must contain a
// plan update and otherwise hold only its own successful results: an id-less
// TodoWrite result classifies as generic tool_activity, so accepting successful
// results keeps `assistant -> TodoWrite -> result -> assistant` a single answer,
// while a failed result keeps the messages distinct so the failure surfaces.
function isReconciliationItem(it: FeedItem): boolean {
  if (it.type !== 'tools') return false;
  let hasPlan = false;
  for (const e of it.events) {
    if (classifyEvent(e) === 'plan_update') {
      hasPlan = true;
      continue;
    }
    if (e.kind === 'tool_result' && !e.isError) continue;
    return false;
  }
  return hasPlan;
}

// Join a trailing assistant fragment back onto the running final answer.
function mergeAssistantMessages(
  prev: Extract<FeedItem, { type: 'message' }>,
  next: Extract<FeedItem, { type: 'message' }>,
): Extract<FeedItem, { type: 'message' }> {
  const text = [prev.event.text ?? '', next.event.text ?? '']
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    ...next,
    key: prev.key,
    event: {
      ...next.event,
      text,
      ts: prev.event.ts,
    },
  };
}

// Collapse a completed assistant turn: thinking/tool/file activity folds into
// "Worked for …" groups while assistant chat messages, child session cards, and
// compaction dividers stay top-level. Invariant (#18): an assistant message is
// ALWAYS a top-level boundary and can never be nested inside a Worked group,
// no matter what trailing compaction/tool status follows it.
function collapseRun(run: FeedItem[], specContent?: string): FeedItem[] {
  if (run.length === 0) return [];
  const out: FeedItem[] = [];
  // A fragment equal to the pinned spec is suppressed by FeedItemView only when
  // its whole text matches the spec, so it must never be merged into prose (that
  // would defeat the match and render the spec body twice).
  const spec = specContent?.trim();
  const isSpecBody = (text: string | undefined) => !!spec && (text ?? '').trim() === spec;
  // Fold contiguous work into "Worked for …" groups. Per-spawn child_session
  // lines stay top-level so they remain visible (and navigable) after a turn,
  // while child_sessions wave cards fold with the rest of the turn — they exist
  // only in dock mode, where a finished wave's job is done.
  let buf: FeedItem[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    if (buf.some((it) => it.type === 'message')) {
      // Should never happen: assistant chat must stay top-level (#18).
      console.warn('[transcript] assistant message folded into Worked activity group');
    }
    const { start, end } = spanOf(buf);
    out.push({
      type: 'worked',
      key: `worked-${buf[0].key}`,
      items: buf,
      durationMs: Math.max(0, end - start),
    });
    buf = [];
  };
  for (const it of run) {
    if (it.type === 'message') {
      // Assistant chat (user messages were already split out by groupTurns).
      // #19: when only a todo/plan reconciliation separates this fragment from
      // the running answer, the model emitted its answer, updated the checklist,
      // then finished the sentence, so it's one final response. Merge the
      // fragments and drop the internal reconciliation so the turn renders a
      // single final answer instead of burying it behind a "Worked" group.
      const prev = out[out.length - 1];
      if (
        it.event.author !== 'user' &&
        !isSpecBody(it.event.text) &&
        buf.length > 0 &&
        buf.every(isReconciliationItem) &&
        prev?.type === 'message' &&
        prev.event.author !== 'user' &&
        !isSpecBody(prev.event.text)
      ) {
        out[out.length - 1] = mergeAssistantMessages(prev, it);
        buf = [];
        continue;
      }
      flush();
      out.push(it);
    } else if (it.type === 'child_session') {
      flush();
      out.push(it);
    } else if (it.type === 'error') {
      // A failed tool/result must stay visible after the turn completes instead
      // of being buried in a collapsed "Worked for …" group (classifier intent).
      flush();
      out.push(it);
    } else if (it.type === 'status' && it.event.kind === 'compaction') {
      flush();
      out.push(it);
    } else if (
      it.type === 'status' &&
      isCompactionCompleteStatus(it.event.text) &&
      it.event.compactType === 'manual'
    ) {
      flush();
      out.push(it);
    } else buf.push(it);
  }
  flush();
  return out;
}

// Fold completed assistant turns into "Worked for …" groups. The in-flight turn
// (while pending) is left expanded so live thinking/tools/status keep streaming.
// When `changes` is set, a completed turn that edited files gets a top-level
// "Changes · N files" summary appended so it survives the Worked-for folding.
export function groupTurns(
  items: FeedItem[],
  pending: boolean,
  specContent?: string,
  changes = false,
): FeedItem[] {
  const out: FeedItem[] = [];
  let i = 0;
  while (i < items.length) {
    if (isUserMessage(items[i])) {
      out.push(items[i]);
      i++;
      continue;
    }
    const run: FeedItem[] = [];
    while (i < items.length && !isUserMessage(items[i])) {
      run.push(items[i]);
      i++;
    }
    const isLastRun = i >= items.length;
    if (isLastRun && pending) {
      out.push(...run);
    } else {
      out.push(...collapseRun(run, specContent));
      if (changes) {
        const files = collectTurnFiles(run);
        if (files.length > 0) {
          out.push({
            type: 'turnChanges',
            key: `changes-${run[0].key}`,
            tailEventId: feedItemTailId(run[run.length - 1]),
            files,
            added: files.reduce((s, f) => s + f.added, 0),
            removed: files.reduce((s, f) => s + f.removed, 0),
          });
        }
      }
    }
  }
  return out;
}

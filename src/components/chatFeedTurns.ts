import { feedItemTailId } from '../hooks/conversationViewportAnchor';
import { classifyEvent } from '../lib/transcript';
import { isSubagentBookkeepingTool } from '../lib/tools';
import type { TranscriptEvent } from '../types/bridge';
import {
  buildFeed,
  collectTurnFiles,
  isCancellationArtifact,
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

// Collapse a completed assistant turn: everything the turn did — thinking,
// tool/file activity, statuses, compaction dividers, child-session lines, and
// the assistant's mid-turn notes — folds into ONE "Worked for …" group between
// the prompt and the answer, so a settled turn reads prompt → Worked → final
// response and expanding the fold replays the whole turn (compaction dividers
// included) at the configured density. Only two things stay top-level: the
// turn's final answer (its last assistant message, plus earlier fragments
// split off purely by todo/plan reconciliation, #19) and errors, so failures
// remain visible. Invariant (#18): the final answer itself is never nested
// inside a Worked group, no matter what trailing work or status follows it.
function collapseRun(run: FeedItem[], specContent?: string): FeedItem[] {
  if (run.length === 0) return [];
  const out: FeedItem[] = [];
  // A fragment equal to the pinned spec is suppressed by FeedItemView only when
  // its whole text matches the spec, so it must never be merged into prose (that
  // would defeat the match and render the spec body twice) nor serve as the
  // turn's answer (the pinned spec card already renders it).
  const spec = specContent?.trim();
  const isSpecBody = (text: string | undefined) => !!spec && (text ?? '').trim() === spec;
  const isAnswerCandidate = (it: FeedItem): it is Extract<FeedItem, { type: 'message' }> =>
    it.type === 'message' && it.event.author !== 'user' && !isSpecBody(it.event.text);

  // Find the final answer: the run's last answer candidate, extended backwards
  // across gaps holding only todo/plan reconciliation — the model emitted its
  // answer, updated the checklist, then finished the sentence, so those
  // fragments are one response (#19). The internal reconciliation items are
  // dropped, not folded.
  let lastMsg = -1;
  for (let i = run.length - 1; i >= 0; i--) {
    if (isAnswerCandidate(run[i])) {
      lastMsg = i;
      break;
    }
  }
  const answerIdx: number[] = [];
  const dropIdx = new Set<number>();
  if (lastMsg >= 0) {
    answerIdx.push(lastMsg);
    let s = lastMsg;
    while (s > 0) {
      let j = s - 1;
      while (j >= 0 && isReconciliationItem(run[j])) j--;
      // Only a reconciliation gap (at least one reconciliation item) followed
      // by another answer candidate extends the final answer backwards.
      if (j === s - 1 || j < 0 || !isAnswerCandidate(run[j])) break;
      for (let k = j + 1; k < s; k++) dropIdx.add(k);
      answerIdx.unshift(j);
      s = j;
    }
  }
  const answerSet = new Set(answerIdx);
  let answer: Extract<FeedItem, { type: 'message' }> | undefined;
  for (const i of answerIdx) {
    const fragment = run[i] as Extract<FeedItem, { type: 'message' }>;
    answer = answer ? mergeAssistantMessages(answer, fragment) : fragment;
  }

  // One fold per turn: every foldable item joins the same Worked group even
  // when work continues past the last assistant text, so a turn never shatters
  // into several folds. The group renders before the turn's top-level
  // survivors (the answer and any errors, kept in transcript order).
  const foldables: FeedItem[] = [];
  const survivors: FeedItem[] = [];
  let answerPushed = false;
  for (let i = 0; i < run.length; i++) {
    if (dropIdx.has(i)) continue;
    const it = run[i];
    if (answerSet.has(i)) {
      // All fragments collapse into the one answer, emitted where the answer
      // started; later fragments were already merged into it.
      if (!answerPushed && answer) {
        survivors.push(answer);
        answerPushed = true;
      }
      continue;
    }
    if (it.type === 'error') {
      // A failed tool/result must stay visible after the turn completes instead
      // of being buried in a collapsed "Worked for …" group (classifier intent).
      survivors.push(it);
    } else {
      foldables.push(it);
    }
  }
  if (foldables.length > 0) {
    const { start, end } = spanOf(foldables);
    out.push({
      type: 'worked',
      key: `worked-${foldables[0].key}`,
      items: foldables,
      durationMs: Math.max(0, end - start),
    });
  }
  out.push(...survivors);
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

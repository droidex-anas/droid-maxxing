import type { TranscriptEvent } from '../types/bridge';
import type { TurnChangesItem, TurnFile } from '../components/TurnChangesPanel';
import { feedItemTailId } from '../hooks/conversationViewportAnchor';
import { hasCompleteAppBlock } from './appBlocks';
import { mergeChildSessionSpawn, type ChildSessionActivity } from './childSessions';
import { extractFileChange, type FileChange } from './diff';
import type { ToolActivityDensity } from './toolActivity';
import { classifyEvent } from './transcript';
import { hasTodoPayload, isChildSessionTool, isSubagentBookkeepingTool, toolMeta } from './tools';

// Whether `next` is the tool_result produced by the `call` event. Result events
// carry no usable `toolName` (the live SDK emits "" and history reads the empty
// result name), so classification cannot identify them; correlate by toolUseId
// instead. When either side has an id, require an exact match so a call never
// swallows an unrelated result (replayed transcripts batch several calls before
// their results); fall back to adjacency only when neither side has an id (the
// live stream emits each result immediately after its call).
export function isResultFor(call: TranscriptEvent, next: TranscriptEvent | undefined): boolean {
  if (next?.kind !== 'tool_result') return false;
  // A failed result must always surface so the user sees the failure, even when
  // it correlates to the call we are otherwise hiding (e.g. a failed TodoWrite).
  if (next.isError) return false;
  if (call.toolUseId || next.toolUseId) return call.toolUseId === next.toolUseId;
  return true;
}

// Pair each tool_call with its tool_result across the whole group. Results
// correlate by toolUseId wherever they sit (replayed transcripts batch several
// calls before their results, so the result is often not adjacent); id-less
// live results fall back to the call they immediately follow. Returns the
// inline output for non-plan calls plus the set of results already accounted
// for, so the renderer never shows a correlated result a second time as raw
// activity. A plan_update's own *successful* result is consumed silently (the
// checklist conveys it); a failed one is left to surface.
export function correlateResults(events: TranscriptEvent[]): {
  resultByCall: Map<TranscriptEvent, TranscriptEvent>;
  consumed: Set<TranscriptEvent>;
} {
  const resultByCall = new Map<TranscriptEvent, TranscriptEvent>();
  const consumed = new Set<TranscriptEvent>();
  const resultById = new Map<string, TranscriptEvent>();
  for (const e of events)
    if (e.kind === 'tool_result' && e.toolUseId) resultById.set(e.toolUseId, e);
  for (let i = 0; i < events.length; i++) {
    const call = events[i];
    if (call.kind !== 'tool_call') continue;
    let result: TranscriptEvent | undefined;
    if (call.toolUseId) {
      result = resultById.get(call.toolUseId);
    } else {
      const next = events[i + 1];
      if (next?.kind === 'tool_result' && !next.toolUseId) result = next;
    }
    if (!result || consumed.has(result)) continue;
    // A failed plan result must surface (the checklist cannot convey a failure),
    // so it is left unconsumed. Every other result — success or failure —
    // attaches to its call so a failure folds into the tool card as an "error".
    if (result.isError && classifyEvent(call) === 'plan_update') continue;
    if (classifyEvent(call) !== 'plan_update') resultByCall.set(call, result);
    consumed.add(result);
  }
  return { resultByCall, consumed };
}

/* ── Feed model ── */
export type ActivityFeedItem = {
  type: 'activity';
  key: string;
  items: FeedItem[];
  active: boolean;
};

export type FeedItem =
  | { type: 'message'; key: string; event: TranscriptEvent }
  | { type: 'thinking'; key: string; event: TranscriptEvent; durationMs?: number }
  | { type: 'status'; key: string; event: TranscriptEvent }
  | { type: 'error'; key: string; event: TranscriptEvent }
  | { type: 'diff'; key: string; event: TranscriptEvent; change: FileChange }
  | { type: 'diffs'; key: string; changes: { event: TranscriptEvent; change: FileChange }[] }
  | { type: 'child_session'; key: string; event: TranscriptEvent }
  // One contiguous run of Task spawns (a turn's subagent wave); rendered as a
  // single subagents dock card scoped to just these spawns.
  | { type: 'child_sessions'; key: string; events: TranscriptEvent[] }
  | { type: 'tools'; key: string; events: TranscriptEvent[] }
  | ActivityFeedItem
  | { type: 'worked'; key: string; items: FeedItem[]; durationMs: number }
  | TurnChangesItem;

// Collect the files a turn's run edited, folding repeated edits to the same
// path into a single entry (summed line counts). Order follows first touch.
export function collectTurnFiles(run: FeedItem[]): TurnFile[] {
  const byPath = new Map<string, TurnFile>();
  const consider = (c: FileChange) => {
    const cur = byPath.get(c.path);
    if (cur) {
      cur.added += c.added;
      cur.removed += c.removed;
      // A file created then edited in one turn reads best as a creation.
      if (c.verb === 'create') cur.verb = 'create';
    } else {
      byPath.set(c.path, { path: c.path, added: c.added, removed: c.removed, verb: c.verb });
    }
  };
  for (const it of run) {
    if (it.type === 'diff') consider(it.change);
    else if (it.type === 'diffs')
      it.changes.forEach((c) => {
        consider(c.change);
      });
  }
  return [...byPath.values()];
}

// Artifacts the SDK persists when the user stops a run: a failed tool_result for
// each in-flight tool ("… cancelled by user") plus a "Request interrupted/
// cancelled by user" note. A user Stop is not a failure, so these are hidden
// from the feed — both live and on replay.
export function isCancellationArtifact(e: TranscriptEvent): boolean {
  const text = (e.text ?? '').trim();
  if (!text) return false;
  if (e.isError && /cancell?ed by user/i.test(text)) return true;
  if (/^request (interrupted|cancell?ed) by user\.?$/i.test(text)) return true;
  return false;
}

export interface BuildFeedOptions {
  // Render child-session spawns as cards/lines instead of plain tool calls.
  childSessionCards?: boolean;
  // Group each contiguous run of spawns into one wave item for the dock card.
  groupChildSessions?: boolean;
}

export function buildFeed(
  events: TranscriptEvent[],
  { childSessionCards = false, groupChildSessions = false }: BuildFeedOptions = {},
): FeedItem[] {
  events = events.filter((e) => !isCancellationArtifact(e));
  const items: FeedItem[] = [];
  // toolUseId → index of its spawn item, so streaming deltas collapse into one.
  const childSessionIndex = new Map<string, number>();
  // toolUseIds whose successful completion result must be dropped wherever it
  // lands: a child session spawn's result is represented by its card, and a plan
  // (TodoWrite) result is pure orchestration noise. History results carry no
  // toolName, and replay can batch a result into a different tool group than its
  // call (e.g. a child session spawn splits the group between a plan call and its
  // result), so adjacency/positional checks are not enough — correlate by id
  // across the whole feed. A *failed* such result is never dropped; it surfaces
  // as an error instead. Pre-scanned so it works regardless of call/result order.
  const childSessionResultIds = new Set<string>();
  const planResultIds = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || !e.toolUseId) continue;
    // Subagent polls (TaskOutput/TaskStop) belong to the wave card the same way a
    // spawn's own result does: the card reports the status they carry, and their
    // bodies are the subagent's output echoed back into the parent feed. Only the
    // grouped card speaks for them, so views that keep per-spawn lines keep them.
    if (childSessionCards && isChildSessionTool(e.toolName, e.toolArgs))
      childSessionResultIds.add(e.toolUseId);
    else if (groupChildSessions && isSubagentBookkeepingTool(e.toolName))
      childSessionResultIds.add(e.toolUseId);
    else if (classifyEvent(e) === 'plan_update') planResultIds.add(e.toolUseId);
  }
  const isCardResult = (e: TranscriptEvent) =>
    e.kind === 'tool_result' &&
    !!e.toolUseId &&
    (childSessionResultIds.has(e.toolUseId) || planResultIds.has(e.toolUseId));
  // toolUseId → its successful result, so a tools group can reclaim a result that
  // a child session spawn split away from its call (the spawn breaks the group, so the
  // call is finalized before its result is reached). Pulled results are marked
  // claimed and skipped when iteration later reaches them, instead of rendering
  // as a detached raw "Tool result".
  const resultById = new Map<string, TranscriptEvent>();
  for (const e of events)
    if (e.kind === 'tool_result' && e.toolUseId && !e.isError) resultById.set(e.toolUseId, e);
  const claimed = new Set<TranscriptEvent>();
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    // A result reclaimed by an earlier group (its call was split from it by a
    // child session spawn) must not also start a new group here.
    if (ev.kind === 'tool_result' && claimed.has(ev)) {
      i++;
      continue;
    }
    // A successful child session/plan completion result is already represented by its
    // card or checklist (or is noise); drop it wherever it lands. Failed ones
    // fall through to the error branch below so the failure still surfaces.
    if (isCardResult(ev) && !ev.isError) {
      i++;
      continue;
    }
    if (ev.author === 'user' || ev.kind === 'text') {
      items.push({ type: 'message', key: ev.id, event: ev });
      i++;
      continue;
    }
    if (ev.kind === 'thinking') {
      const next = events[i + 1];
      const end = ev.endTs ?? next?.ts;
      items.push({
        type: 'thinking',
        key: ev.id,
        event: ev,
        durationMs: end != null ? Math.max(0, end - ev.ts) : undefined,
      });
      i++;
      continue;
    }
    if (ev.kind === 'compaction' || ev.kind === 'status') {
      items.push({ type: 'status', key: ev.id, event: ev });
      i++;
      continue;
    }
    // A pure error event (no tool call) and a failed child session/plan result surface
    // as a standalone error. An ordinary failed tool result is not diverted here;
    // it flows into its tool group below and folds into the tool card as an error.
    if (ev.kind === 'error' || (ev.isError && isCardResult(ev))) {
      items.push({ type: 'error', key: ev.id, event: ev });
      i++;
      continue;
    }
    if (ev.kind === 'tool_call') {
      const change = extractFileChange(ev.toolName, ev.toolArgs);
      if (change) {
        // Fold a contiguous run of file edits into one collapsible group so a
        // large multi-file change doesn't bury the chat under dozens of cards.
        const changes: { event: TranscriptEvent; change: FileChange }[] = [];
        // Dedupe by toolUseId: a single edit can arrive as many streaming
        // tool_call snapshots; counting each one inflates the diff stats and
        // floods the group with repeated rows. Keep only the latest per call.
        const byToolUse = new Map<string, number>();
        const addChange = (e: TranscriptEvent, c: FileChange) => {
          const at = e.toolUseId ? byToolUse.get(e.toolUseId) : undefined;
          if (at != null) changes[at] = { event: e, change: c };
          else {
            if (e.toolUseId) byToolUse.set(e.toolUseId, changes.length);
            changes.push({ event: e, change: c });
          }
        };
        addChange(ev, change);
        i++;
        while (i < events.length) {
          const t = events[i];
          // Real transcripts interleave each edit's tool_result between calls;
          // fold a successful edit result into the run so consecutive edits group
          // into one card. A failed result breaks out so it can surface.
          if (t.kind === 'tool_result') {
            if (t.isError) break;
            i++;
            continue;
          }
          if (t.kind !== 'tool_call') break;
          const c = extractFileChange(t.toolName, t.toolArgs);
          if (!c) break;
          addChange(t, c);
          i++;
        }
        if (changes.length === 1)
          items.push({
            type: 'diff',
            key: changes[0].event.id,
            event: changes[0].event,
            change: changes[0].change,
          });
        else items.push({ type: 'diffs', key: `diffs-${ev.id}`, changes });
        continue;
      }
      // Polling or stopping an existing subagent is bookkeeping the wave card
      // already speaks for, so it never becomes a row of its own.
      if (groupChildSessions && isSubagentBookkeepingTool(ev.toolName)) {
        i++;
        if (isResultFor(ev, events[i])) i++;
        continue;
      }
      if (childSessionCards && isChildSessionTool(ev.toolName, ev.toolArgs)) {
        const key = ev.toolUseId ?? ev.id;
        const at = childSessionIndex.get(key);
        if (at == null) {
          if (groupChildSessions) {
            // Merge into the trailing wave item so a turn's spawns stay one
            // card at the spot where the spawning happened.
            const prevIdx = items.length - 1;
            const prev: FeedItem | undefined = items.length > 0 ? items[prevIdx] : undefined;
            if (prev?.type === 'child_sessions') {
              childSessionIndex.set(key, prevIdx);
              items[prevIdx] = { ...prev, events: [...prev.events, ev] };
            } else {
              childSessionIndex.set(key, items.length);
              items.push({ type: 'child_sessions', key: `child-sessions-${key}`, events: [ev] });
            }
          } else {
            childSessionIndex.set(key, items.length);
            items.push({ type: 'child_session', key: `child-session-${key}`, event: ev });
          }
        } else {
          const cur = items[at];
          if (cur.type === 'child_sessions') {
            items[at] = {
              ...cur,
              events: cur.events.map((e) =>
                (e.toolUseId ?? e.id) === key ? mergeChildSessionSpawn(e, ev) : e,
              ),
            };
          } else if (cur.type === 'child_session') {
            items[at] = { ...cur, event: mergeChildSessionSpawn(cur.event, ev) };
          }
        }
        i++;
        // Advance past an adjacent successful completion result (the common live
        // case); a result batched elsewhere is dropped by the group-wide guards.
        // Correlate by toolUseId since history results carry no toolName.
        if (isResultFor(ev, events[i])) i++;
        continue;
      }
    }
    if (ev.kind === 'tool_call' || ev.kind === 'tool_result') {
      const group: TranscriptEvent[] = [];
      while (i < events.length) {
        const t = events[i];
        if (t.kind === 'tool_result') {
          // A failed child session/plan result breaks the group so the outer loop
          // surfaces it as a standalone error (its card/checklist can't convey
          // the failure). An ordinary failed result stays so it folds into its
          // tool card.
          if (t.isError && isCardResult(t)) break;
          // A successful child session/plan result is dropped (represented by its
          // card or checklist, or pure noise); other results stay in the group.
          if (!t.isError && isCardResult(t)) {
            i++;
            continue;
          }
          // A result already reclaimed inline by an earlier group (its call was
          // split from it by a child session spawn) must not be re-emitted here as
          // raw activity, which would duplicate the output.
          if (claimed.has(t)) {
            i++;
            continue;
          }
          group.push(t);
          i++;
          continue;
        }
        // A child session spawn must break the group so the outer loop can render it
        // as its own card instead of folding it into the generic tools group.
        if (
          childSessionCards &&
          t.kind === 'tool_call' &&
          isChildSessionTool(t.toolName, t.toolArgs)
        )
          break;
        // Skipped rather than breaking the group, so a poll landing between two
        // real tool calls does not split them into two cards.
        if (groupChildSessions && t.kind === 'tool_call' && isSubagentBookkeepingTool(t.toolName)) {
          i++;
          continue;
        }
        if (t.kind === 'tool_call' && !extractFileChange(t.toolName, t.toolArgs)) {
          group.push(t);
          i++;
          continue;
        }
        break;
      }
      if (group.length) {
        // Reclaim any successful result whose call is in this group but was
        // separated from it (a child session spawn broke the group before the result
        // was reached) so it renders inline with its call rather than as a
        // detached raw result later. Card/plan results are intentionally left
        // out (handled by their card/checklist or dropped as noise).
        for (const c of group) {
          if (c.kind !== 'tool_call' || !c.toolUseId) continue;
          const r = resultById.get(c.toolUseId);
          if (r && !group.includes(r) && !isCardResult(r)) {
            group.push(r);
            claimed.add(r);
          }
        }
        items.push({ type: 'tools', key: group[0].id, events: dedupePlanUpdates(group) });
      } else i++;
      continue;
    }
    i++;
  }
  return items;
}

// Repeated TodoWrite calls in one activity group are noise (#20): keep only the
// latest plan snapshot and drop the superseded ones (and their empty results).
function dedupePlanUpdates(events: TranscriptEvent[]): TranscriptEvent[] {
  const plans = events.filter((e) => e.kind === 'tool_call' && classifyEvent(e) === 'plan_update');
  if (plans.length <= 1) return events;
  // A partial tool_call_delta normalizes as a plan_update carrying the tool name
  // but no `todos` payload; it must never become the kept snapshot or it would
  // replace the complete checklist with an empty "Updated plan". Prefer the
  // latest plan that has a real Todo payload (mirroring RightPanel), falling
  // back to the last plan only when none carry one.
  const withPayload = plans.filter((p) => hasTodoPayload(p.toolArgs));
  const keepId = (
    withPayload.length ? withPayload[withPayload.length - 1] : plans[plans.length - 1]
  ).id;
  // toolUseIds of superseded plan calls, so their own results are dropped no
  // matter where they sit in the group (replay batches calls before results).
  const supersededIds = new Set<string>();
  for (const plan of plans) {
    if (plan.id !== keepId && plan.toolUseId) supersededIds.add(plan.toolUseId);
  }
  const out: TranscriptEvent[] = [];
  for (let j = 0; j < events.length; j++) {
    const e = events[j];
    if (e.kind === 'tool_call' && classifyEvent(e) === 'plan_update' && e.id !== keepId) {
      // id-less live result sits right after its call; id-correlated results are
      // dropped by the supersededIds check below. Never drop a failed result.
      if (!e.toolUseId && isResultFor(e, events[j + 1])) j++;
      continue;
    }
    if (e.kind === 'tool_result' && !e.isError && e.toolUseId && supersededIds.has(e.toolUseId)) {
      continue;
    }
    out.push(e);
  }
  return out;
}

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
  density?: ToolActivityDensity;
};

export function buildGroupedFeed(
  events: TranscriptEvent[],
  pending: boolean,
  { specContent, changes = false, density, ...feedOptions }: GroupedFeedOptions = {},
): FeedItem[] {
  return groupTurns(
    buildFeed(events, feedOptions),
    pending,
    specContent,
    changes,
    density ?? 'compact',
  );
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
  if (item.type === 'activity') return tailTimestamp(item.items.at(-1));
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
    else if (it.type === 'activity') {
      const nested = spanOf(it.items);
      consider(nested.start, nested.end);
    } else if (it.type !== 'worked' && it.type !== 'turnChanges')
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

function isFoldableToolItem(it: FeedItem): boolean {
  return it.type === 'tools' || it.type === 'diff' || it.type === 'diffs';
}

export function foldActivityItems(items: FeedItem[], trailingLive: boolean): FeedItem[] {
  const out: FeedItem[] = [];
  let buf: FeedItem[] = [];
  const flush = (active: boolean) => {
    if (buf.length === 0) return;
    out.push({
      type: 'activity',
      key: `activity-${buf[0].key}`,
      items: [...buf],
      active,
    });
    buf = [];
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isFoldableToolItem(it)) buf.push(it);
    else {
      flush(false);
      out.push(it);
    }
  }
  const live = trailingLive && buf.length > 0;
  flush(live);
  return out;
}

function appendTurnChanges(out: FeedItem[], run: FeedItem[]): void {
  const files = collectTurnFiles(run);
  if (files.length === 0) return;
  out.push({
    type: 'turnChanges',
    key: `changes-${run[0].key}`,
    tailEventId: feedItemTailId(run[run.length - 1]),
    files,
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
  });
}

export function summarizeActivity(items: FeedItem[], active: boolean): string {
  let files = 0;
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let fetches = 0;
  let plans = 0;
  let others = 0;

  const countCall = (e: TranscriptEvent) => {
    if (e.kind !== 'tool_call') return;
    if (classifyEvent(e) === 'plan_update') {
      plans += 1;
      return;
    }
    switch (toolMeta(e.toolName, e.toolArgs).cat) {
      case 'exec':
        commands += 1;
        return;
      case 'read':
        reads += 1;
        return;
      case 'search':
        searches += 1;
        return;
      case 'web':
        fetches += 1;
        return;
      case 'edit':
      case 'create':
        files += 1;
        return;
      default:
        others += 1;
    }
  };

  for (const it of items) {
    if (it.type === 'diff') files += 1;
    else if (it.type === 'diffs') files += it.changes.length;
    else if (it.type === 'tools') it.events.forEach(countCall);
  }

  const kindCount =
    Number(files > 0) +
    Number(commands > 0) +
    Number(reads > 0) +
    Number(searches > 0) +
    Number(fetches > 0) +
    Number(plans > 0) +
    Number(others > 0);

  // Reads join a files+commands header without a third clause.
  if (files > 0 && commands > 0 && searches === 0 && fetches === 0 && plans === 0 && others === 0) {
    return active ? 'Editing files, running commands' : 'Edited files, ran commands';
  }
  if (kindCount === 1) {
    if (commands > 0) return active ? `Running ${commands} commands` : `Ran ${commands} commands`;
    if (files > 0) return active ? 'Editing files' : 'Edited files';
    if (reads > 0) return active ? 'Reading files' : `Read ${reads} files`;
    if (searches > 0) return active ? 'Searching' : 'Searched';
    if (fetches > 0) return active ? 'Fetching' : 'Fetched pages';
    if (plans > 0) return active ? 'Updating plan' : 'Updated plan';
  }
  return active ? 'Working' : 'Ran tools';
}

// Fold completed assistant turns into "Worked for …" groups. The in-flight turn
// (while pending) is left expanded so live thinking/tools/status keep streaming.
// Compact density instead folds foldable tool/diff items into activity groups
// on every run, including the live last run. When `changes` is set, a completed
// turn that edited files gets a top-level "Changes · N files" summary.
export function groupTurns(
  items: FeedItem[],
  pending: boolean,
  specContent?: string,
  changes = false,
  density: ToolActivityDensity = 'verbose',
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
    const trailingLive = isLastRun && pending;
    if (density === 'compact') {
      out.push(...foldActivityItems(run, trailingLive));
      if (!trailingLive && changes) appendTurnChanges(out, run);
      continue;
    }
    if (trailingLive) {
      out.push(...run);
    } else {
      out.push(...collapseRun(run, specContent));
      if (changes) appendTurnChanges(out, run);
    }
  }
  return out;
}

// Two feed items render identically when they wrap the same underlying transcript
// event objects. The store keeps prior events referentially stable and only swaps
// the streaming tail event for a new object, so this ref check is enough: every
// other FeedItem field (diff stats, durations, summaries) is a pure function of
// these events.
export function sameFeedEvents(a: FeedItem, b: FeedItem): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === 'tools' && b.type === 'tools') {
    return a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]);
  }
  if (a.type === 'diffs' && b.type === 'diffs') {
    return (
      a.changes.length === b.changes.length &&
      a.changes.every((c, i) => c.event === b.changes[i].event)
    );
  }
  if (a.type === 'child_sessions' && b.type === 'child_sessions') {
    return a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]);
  }
  if (a.type === 'activity' && b.type === 'activity') {
    return (
      a.active === b.active &&
      a.items.length === b.items.length &&
      a.items.every((it, i) => sameFeedEvents(it, b.items[i]))
    );
  }
  // message | thinking | status | error | diff | child session each carry one event.
  return (a as { event: TranscriptEvent }).event === (b as { event: TranscriptEvent }).event;
}

export function childSessionLineIsRunning(activity?: ChildSessionActivity): boolean {
  return activity?.status === 'running';
}

// Only genuinely appended items (new keys appearing at the tail) animate in.
// Paging older history prepends already-past messages at the top; those and
// every previously-rendered item must stay still rather than re-animating as if
// they were fresh activity. Walking from the tail collects the contiguous run of
// new keys and stops at the first previously-seen item, so a prepend (new keys
// ahead of the old ones) animates nothing.
export function appendedFeedItemKeys(
  items: readonly { key: string }[],
  previous: { identity: string; keys: Set<string> } | null,
  identity: string,
): Set<string> {
  const appended = new Set<string>();
  if (previous?.identity !== identity) return appended;
  for (let i = items.length - 1; i >= 0; i--) {
    const key = items[i].key;
    if (previous.keys.has(key)) break;
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
  let latestPromptIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'message' && item.event.author === 'user') {
      latestPromptIndex = i;
      break;
    }
  }
  if (latestPromptIndex < 0) return [];

  const responses: string[] = [];
  for (let i = latestPromptIndex + 1; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'message' || item.event.author === 'user') continue;
    const text = item.event.text ?? '';
    if (hasCompleteAppBlock(text)) responses.push(text);
  }
  return responses;
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

// A status line that signals compaction finished.
export function isCompactionCompleteStatus(text?: string): boolean {
  const t = text ?? '';
  return /compact/i.test(t) && /complete/i.test(t);
}

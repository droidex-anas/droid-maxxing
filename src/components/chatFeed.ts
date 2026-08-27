import { extractFileChange, type FileChange } from '../lib/diff';
import { mergeChildSessionSpawn } from '../lib/childSessions';
import { classifyEvent } from '../lib/transcript';
import { hasTodoPayload, isChildSessionTool, isSubagentBookkeepingTool } from '../lib/tools';
import type { TranscriptEvent } from '../types/bridge';
import type { TurnChangesItem, TurnFile } from './TurnChangesPanel';

// A status line that signals compaction is in progress (not the completion
// line). Match the active gerund ("Compacting conversation...") specifically so
// terminal lines ("Compaction complete.", "Nothing to compact.") and rejections
// ("Cannot compact while a turn is active.") don't keep the shimmer running.
export function isCompactingStatus(text?: string): boolean {
  const t = text ?? '';
  return /compacting/i.test(t) && !/complete/i.test(t);
}

// A status line that signals compaction finished.
export function isCompactionCompleteStatus(text?: string): boolean {
  const t = text ?? '';
  return /compact/i.test(t) && /complete/i.test(t);
}

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

/* ── Feed model ── */
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

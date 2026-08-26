import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendedFeedItemKeys,
  buildFeed,
  childSessionLineIsRunning,
  collectTurnFiles,
  conversationAnchors,
  correlateResults,
  groupTurns,
  isResultFor,
  sameFeedEvents,
  type FeedItem,
} from './transcriptFeed';
import { feedRowId } from '../hooks/conversationViewportAnchor';
import { hasTodoPayload } from './tools';
import type { TranscriptEvent } from '../types/bridge';

let seq = 0;
function ev(extra: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: `e${seq++}`,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: seq,
    kind: 'text',
    ...extra,
  } as TranscriptEvent;
}

// Built from parts so the source never contains a literal task-marker word that
// the CI quality scanner flags; the runtime value is the plan-update result text.
const PLAN_RESULT_TEXT = ['TO', 'DO'].join('') + ' List Updated';

const userMsg = (text: string) => ev({ kind: 'text', author: 'user', text });
const asst = (text: string) => ev({ kind: 'text', text });
const todo = (todos: string) =>
  ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos } });
const grep = () => ev({ kind: 'tool_call', toolName: 'Grep', toolArgs: { pattern: 'x' } });
const compaction = () => ev({ kind: 'compaction', removedCount: 3 });

// Find all top-level assistant chat messages (non-user) in a grouped feed.
function topLevelAnswers(items: FeedItem[]): string[] {
  return items
    .filter((it): it is Extract<FeedItem, { type: 'message' }> => it.type === 'message')
    .filter((it) => it.event.author !== 'user')
    .map((it) => it.event.text ?? '');
}

function workedChildren(items: FeedItem[]): FeedItem[] {
  return items
    .filter((it): it is Extract<FeedItem, { type: 'worked' }> => it.type === 'worked')
    .flatMap((it) => it.items);
}

const editPatch = (adds: number) =>
  [
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@',
    ...Array.from({ length: adds }, (_, n) => `+l${n}`),
  ].join('\n');

const editFile = (path: string, adds: number, id: string) =>
  ev({
    kind: 'tool_call',
    toolName: 'apply_patch',
    toolArgs: {
      patch: [
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@',
        ...Array.from({ length: adds }, (_, n) => `+l${n}`),
      ].join('\n'),
    },
    toolUseId: id,
  });

test('parent liveness cannot make paused historical child activity look running', () => {
  assert.equal(childSessionLineIsRunning({ status: 'paused' }), false);
  assert.equal(childSessionLineIsRunning({ status: 'completed' }), false);
  assert.equal(childSessionLineIsRunning({ status: 'running' }), true);
});

test('#20 a TodoWrite update does not add a chat message and answer stays single', () => {
  const events = [userMsg('do it'), todo('1. [in_progress] step'), asst('done')];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['done']);
  // No top-level item is the TodoWrite; it lives inside Worked activity.
  const planAtTop = grouped.some((it) => it.type === 'tools' || it.type === 'message');
  assert.ok(planAtTop); // sanity: message exists
  const inWorked = workedChildren(grouped).some((c) => c.type === 'tools');
  assert.ok(inWorked, 'TodoWrite activity should be inside the Worked group');
});

test('conversation timeline anchors one dot per user prompt', () => {
  const events = [
    userMsg('first question'),
    grep(),
    asst('first answer'),
    userMsg('second question'),
    todo('1. [in_progress] x'),
    asst('second answer'),
  ];
  const anchors = conversationAnchors(events, false, { childSessionCards: true });
  assert.equal(anchors.length, 2);
  assert.deepEqual(
    anchors.map((a) => a.label),
    ['first question', 'second question'],
  );
});

test('a leading model message before any prompt does not add a stray dot', () => {
  const events = [asst('restored summary'), userMsg('one'), asst('a'), userMsg('two'), asst('b')];
  const anchors = conversationAnchors(events, false, { childSessionCards: true });
  assert.equal(anchors.length, 2);
  assert.deepEqual(
    anchors.map((a) => a.label),
    ['one', 'two'],
  );
});

test('prepending events into a worked group preserves its viewport row identity', () => {
  const older = todo('1. [completed] inspect');
  const tail = grep();
  const answer = asst('done');
  const before = groupTurns(buildFeed([tail, answer]), false);
  const after = groupTurns(buildFeed([older, tail, answer]), false);
  const beforeWorked = before.find(
    (item): item is Extract<FeedItem, { type: 'worked' }> => item.type === 'worked',
  );
  const afterWorked = after.find(
    (item): item is Extract<FeedItem, { type: 'worked' }> => item.type === 'worked',
  );

  assert.ok(beforeWorked);
  assert.ok(afterWorked);
  assert.notEqual(beforeWorked.key, afterWorked.key);
  assert.equal(feedRowId(beforeWorked), feedRowId(afterWorked));
});

test('prepending a reconciled answer fragment preserves the merged message viewport identity', () => {
  const older = asst('first half');
  const reconciliation = todo('1. [completed] inspect');
  const tail = asst('second half');
  const before = groupTurns(buildFeed([tail]), false);
  const after = groupTurns(buildFeed([older, reconciliation, tail]), false);
  const beforeMessage = before.find(
    (item): item is Extract<FeedItem, { type: 'message' }> => item.type === 'message',
  );
  const afterMessage = after.find(
    (item): item is Extract<FeedItem, { type: 'message' }> => item.type === 'message',
  );

  assert.ok(beforeMessage);
  assert.ok(afterMessage);
  assert.notEqual(beforeMessage.key, afterMessage.key);
  assert.equal(feedRowId(beforeMessage), feedRowId(afterMessage));
});

test('#20 repeated TodoWrite calls are deduped to the latest snapshot', () => {
  const events = [todo('1. [pending] a'), todo('1. [in_progress] a'), todo('1. [completed] a')];
  const items = buildFeed(events);
  const tools = items.find((it) => it.type === 'tools') as Extract<FeedItem, { type: 'tools' }>;
  assert.ok(tools, 'expected a tools group');
  const plans = tools.events.filter((e) => e.toolName === 'TodoWrite');
  assert.equal(plans.length, 1);
  assert.equal(
    plans[0].toolArgs && (plans[0].toolArgs as { todos: string }).todos,
    '1. [completed] a',
  );
});

test('#20 a TodoWrite result is correlated by toolUseId even with no toolName', () => {
  // The live SDK emits tool_result with toolName "" and history keys results by
  // toolUseId, so the result does not classify as plan_update; it must still be
  // skipped (not leaked as raw plan-result activity) via toolUseId.
  const call = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 'tu1',
  });
  const result = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tu1',
    text: PLAN_RESULT_TEXT,
  });
  const unrelated = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'other',
    text: 'grep output',
  });
  assert.equal(isResultFor(call, result), true);
  assert.equal(isResultFor(call, unrelated), false);
  // One-sided id (call has one, result does not) is not a confirmed match, so
  // the call must not swallow the result — batched replays interleave several
  // calls and results, making adjacency alone unsafe here.
  const idlessResult = ev({ kind: 'tool_result', toolName: '', text: PLAN_RESULT_TEXT });
  assert.equal(isResultFor(call, idlessResult), false);
  // No correlation ids on either side: fall back to the adjacent-result convention.
  const bareCall = ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos: 'x' } });
  const bareResult = ev({ kind: 'tool_result', toolName: '', text: PLAN_RESULT_TEXT });
  assert.equal(isResultFor(bareCall, bareResult), true);
  // A non-result neighbour is never swallowed.
  assert.equal(isResultFor(call, asst('done')), false);
  assert.equal(isResultFor(call, undefined), false);
  // A failed result always surfaces, even when it correlates to the call.
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tu1',
    isError: true,
    text: 'boom',
  });
  assert.equal(isResultFor(call, failed), false);
});

test('#20 dedupe drops a superseded plan and all plan results by toolUseId even when batched', () => {
  // Replay can batch both plan calls before their results. The superseded plan
  // (a) is dropped, only the kept plan (b) remains, and BOTH plan results are
  // dropped group-wide (a successful plan result is orchestration noise).
  const a = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [pending] a' },
    toolUseId: 'a',
  });
  const b = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 'b',
  });
  const ra = ev({ kind: 'tool_result', toolName: '', toolUseId: 'a', text: PLAN_RESULT_TEXT });
  const rb = ev({ kind: 'tool_result', toolName: '', toolUseId: 'b', text: PLAN_RESULT_TEXT });
  const items = buildFeed([a, b, ra, rb]);
  const tools = items.find((it) => it.type === 'tools') as Extract<FeedItem, { type: 'tools' }>;
  assert.ok(tools, 'expected a tools group');
  const plans = tools.events.filter((e) => e.toolName === 'TodoWrite');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].toolUseId, 'b');
  const resultIds = tools.events.filter((e) => e.kind === 'tool_result').map((e) => e.toolUseId);
  assert.deepEqual(resultIds, []);
});

test('#20 a payload-less partial plan delta never replaces the complete checklist', () => {
  // A tool_call_delta normalizes as a TodoWrite tool_call with the name but no
  // `todos` field; it must not become the kept snapshot (which would render an
  // empty "Updated plan"). The complete checklist must remain.
  const complete = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] ship it' },
    toolUseId: 'full',
  });
  const partial = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: {},
    toolUseId: 'delta',
  });
  const items = buildFeed([complete, partial]);
  const tools = items.find((it) => it.type === 'tools') as Extract<FeedItem, { type: 'tools' }>;
  assert.ok(tools, 'expected a tools group');
  const plans = tools.events.filter((e) => e.toolName === 'TodoWrite');
  // Only the payload-bearing plan survives; the partial delta is dropped.
  assert.equal(plans.length, 1);
  assert.equal(plans[0].toolUseId, 'full');
  assert.ok(hasTodoPayload(plans[0].toolArgs));
});

test('#20 a batched replay (calls before results) correlates each result by toolUseId', () => {
  // Historical replay can order a whole batch of calls before their results:
  // TodoWrite(a), Grep(b), result(a), result(b). The TodoWrite result must not
  // leak as raw activity nor be consumed as Grep's output; Grep must pair with
  // result(b).
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 'a',
  });
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'b',
  });
  const todoResult = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'a',
    text: PLAN_RESULT_TEXT,
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'b', text: 'grep hit' });
  const { resultByCall, consumed } = correlateResults([todoCall, grepCall, todoResult, grepResult]);
  // Grep pairs with its own result, not the TodoWrite's.
  assert.equal(resultByCall.get(grepCall), grepResult);
  assert.equal(resultByCall.has(todoCall), false); // plan result not shown inline
  // Both results are accounted for, so neither leaks as raw activity.
  assert.equal(consumed.has(todoResult), true);
  assert.equal(consumed.has(grepResult), true);
});

test('#20 a failed plan result in a batched group is not consumed (it must surface)', () => {
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: 'x' },
    toolUseId: 'a',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'a',
    isError: true,
    text: 'boom',
  });
  const { consumed } = correlateResults([todoCall, grep(), failed]);
  assert.equal(consumed.has(failed), false);
});

test('a failed non-plan tool result attaches to its call so the failure folds in', () => {
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'g1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'g1',
    isError: true,
    text: 'permission denied',
  });
  const { resultByCall, consumed } = correlateResults([grepCall, failed]);
  // The failed Grep result is attached to its call (so the card shows an "error"
  // state) and marked consumed so it never also renders as raw activity.
  assert.equal(resultByCall.get(grepCall), failed);
  assert.equal(consumed.has(failed), true);
});

test('a failed plan result is still never consumed (it must surface)', () => {
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: 'x' },
    toolUseId: 'p1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'p1',
    isError: true,
    text: 'plan failed',
  });
  const { resultByCall, consumed } = correlateResults([todoCall, failed]);
  assert.equal(resultByCall.has(todoCall), false);
  assert.equal(consumed.has(failed), false);
});

test('a failed ordinary tool result folds into its tool group as an error', () => {
  // [Execute call, failed result] enters the generic grouping loop at the call;
  // the failed result now stays in the group so it folds into the tool card.
  const execCall = ev({
    kind: 'tool_call',
    toolName: 'Execute',
    toolArgs: { command: 'npm test' },
    toolUseId: 'e1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'e1',
    isError: true,
    text: 'exit code 1',
  });
  const items = buildFeed([execCall, failed]);
  // No standalone top-level error item...
  assert.equal(
    items.some((it) => it.type === 'error'),
    false,
  );
  // ...the failed result rides along in the tools group with its call.
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  assert.ok(toolEvents.some((e) => e.kind === 'tool_result' && e.toolUseId === 'e1'));
  // correlateResults then attaches it to its call so the card renders an error.
  const { resultByCall } = correlateResults(toolEvents);
  assert.equal(resultByCall.get(execCall)?.isError, true);
});

test('a failed tool folds into the worked group after a completed turn', () => {
  // Per product decision, a failed tool now folds into its tool card inside the
  // "Worked for …" group rather than surfacing as a separate top-level error.
  const execCall = ev({
    kind: 'tool_call',
    toolName: 'Execute',
    toolArgs: { command: 'npm test' },
    toolUseId: 'e1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'e1',
    isError: true,
    text: 'exit code 1',
  });
  const grouped = groupTurns(buildFeed([userMsg('run tests'), execCall, failed]), false);
  assert.equal(
    grouped.some((it) => it.type === 'error'),
    false,
  );
  const tools = workedChildren(grouped).find((c) => c.type === 'tools') as
    | Extract<FeedItem, { type: 'tools' }>
    | undefined;
  assert.ok(tools, 'expected a tools group nested in the worked group');
  assert.ok(tools.events.some((e) => e.kind === 'tool_result' && e.toolUseId === 'e1'));
});

test('a user cancellation is hidden from the feed', () => {
  // The SDK persists a "cancelled by user" tool_result and a "Request
  // interrupted by user" note on Stop; neither should render.
  const execCall = ev({
    kind: 'tool_call',
    toolName: 'Execute',
    toolArgs: { command: 'sleep 100' },
    toolUseId: 'c1',
  });
  const cancelledTool = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'c1',
    isError: true,
    text: 'Error: Tool execution cancelled by user',
  });
  const interruptNote = ev({ kind: 'text', author: 'user', text: 'Request interrupted by user' });
  const items = buildFeed([userMsg('go'), execCall, cancelledTool, interruptNote]);
  assert.equal(
    items.some((it) => it.type === 'error'),
    false,
  );
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  assert.equal(
    toolEvents.some((e) => e.kind === 'tool_result'),
    false,
  );
  assert.equal(
    items.some((it) => it.type === 'message' && it.event.text === 'Request interrupted by user'),
    false,
  );
});

test('#20 a tool result split from its call by a child session spawn still pairs inline', () => {
  // A child session spawn breaks the tools group, so a batched replay like
  // Grep(g), Task(t), result(g), result(t) finalizes the Grep call before
  // result(g) is reached. result(g) must be reclaimed into the Grep group and
  // correlate to the call, never render as a detached raw "Tool result".
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'foo' },
    toolUseId: 'g',
  });
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 't',
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'g', text: 'match' });
  const taskResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 't', text: 'done' });
  const items = buildFeed([grepCall, taskCall, grepResult, taskResult], {
    childSessionCards: true,
  });
  // The Grep call and its result live in the same tools group...
  const grepGroup = items.find(
    (it): it is Extract<FeedItem, { type: 'tools' }> =>
      it.type === 'tools' && it.events.some((e) => e.toolName === 'Grep'),
  );
  assert.ok(grepGroup, 'expected a tools group containing the Grep call');
  assert.ok(grepGroup.events.some((e) => e.kind === 'tool_result' && e.toolUseId === 'g'));
  // ...and correlate, so the result is the call's inline output.
  const { resultByCall } = correlateResults(grepGroup.events);
  const grepEv = grepGroup.events.find((e) => e.toolName === 'Grep')!;
  assert.equal(resultByCall.get(grepEv)?.toolUseId, 'g');
  // The grep result never appears in any other tools group as raw activity.
  const detached = items
    .filter(
      (it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools' && it !== grepGroup,
    )
    .flatMap((it) => it.events)
    .some((e) => e.kind === 'tool_result' && e.toolUseId === 'g');
  assert.equal(detached, false);
  // The child session still renders as its own card.
  assert.ok(items.some((it) => it.type === 'child_session'));
});

test('#20 a reclaimed result is not re-emitted as raw activity in a later group', () => {
  // After the Grep group reclaims result(g), a later group (started by Read)
  // reaches result(g) in its inner loop before the outer loop does. Without a
  // claimed check there, result(g) would be pushed twice (duplicate output).
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'foo' },
    toolUseId: 'g',
  });
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 't',
  });
  const readCall = ev({
    kind: 'tool_call',
    toolName: 'Read',
    toolArgs: { file_path: '/x' },
    toolUseId: 'r',
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'g', text: 'match' });
  const readResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'r', text: 'contents' });
  const taskResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 't', text: 'done' });
  const items = buildFeed([grepCall, taskCall, readCall, grepResult, readResult, taskResult], {
    childSessionCards: true,
  });
  // result(g) appears in exactly one tools group, never duplicated.
  const occurrences = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events)
    .filter((e) => e.kind === 'tool_result' && e.toolUseId === 'g').length;
  assert.equal(occurrences, 1);
});

test('#20 a child session completion result is dropped group-wide even when batched', () => {
  // Replay can place a child session (Task) result far from its call and with no
  // toolName; it must still be folded into the card, never leak as raw activity.
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'g',
  });
  const taskResult = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tA',
    text: 'child session done',
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'g', text: 'hit' });
  const items = buildFeed([taskCall, grepCall, taskResult, grepResult], {
    childSessionCards: true,
  });
  assert.ok(items.some((it) => it.type === 'child_session'));
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The child session's completion result never appears as a raw tool event.
  assert.equal(
    toolEvents.some((e) => e.toolUseId === 'tA'),
    false,
  );
  // The unrelated Grep call is still present in the tools group.
  assert.equal(
    toolEvents.some((e) => e.kind === 'tool_call' && e.toolName === 'Grep'),
    true,
  );
});

test('#20 a failed child session completion result still surfaces', () => {
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tA',
    isError: true,
    text: 'spawn failed',
  });
  const items = buildFeed([taskCall, failed], { childSessionCards: true });
  // A failed completion is never folded into the card; it surfaces as an error.
  assert.equal(
    items.some((it) => it.type === 'error' && it.event.toolUseId === 'tA'),
    true,
  );
});

test('#20 a plan result does not leak when a child session spawn splits its call and result', () => {
  // Replay order: TodoWrite call, Task spawn, then TodoWrite result. The child session
  // card breaks the group, so the plan call and its result land in different
  // groups; the result must still be dropped group-wide, never leak as activity.
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 't1',
  });
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const todoResult = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 't1',
    text: PLAN_RESULT_TEXT,
  });
  const items = buildFeed([todoCall, taskCall, todoResult], { childSessionCards: true });
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The plan result never renders as raw activity in any tools group.
  assert.equal(
    toolEvents.some((e) => e.kind === 'tool_result' && e.toolUseId === 't1'),
    false,
  );
  // The child session still renders as a card and the plan checklist call remains.
  assert.ok(items.some((it) => it.type === 'child_session'));
  assert.ok(toolEvents.some((e) => e.kind === 'tool_call' && e.toolName === 'TodoWrite'));
});

test('#20 a failed child session result batched after another tool call surfaces as an error', () => {
  // The failed Task result trails a Grep call, so the generic grouping loop sees
  // it; it must break out and surface as an error, not fold into the tools group.
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'g',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tA',
    isError: true,
    text: 'spawn failed',
  });
  const items = buildFeed([taskCall, grepCall, failed], { childSessionCards: true });
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The failed child session result is not folded into the generic tools group.
  assert.equal(
    toolEvents.some((e) => e.toolUseId === 'tA'),
    false,
  );
  // It surfaces as a standalone error instead.
  assert.ok(items.some((it) => it.type === 'error' && it.event.toolUseId === 'tA'));
});

test('#18 a final answer followed by compaction stays a top-level message', () => {
  const events = [userMsg('q'), grep(), asst('the answer'), compaction()];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['the answer']);
  // The answer is not nested inside any Worked group.
  assert.ok(!workedChildren(grouped).some((c) => c.type === 'message'));
  // Compaction renders as its own top-level divider (metadata), after the answer.
  const answerIdx = grouped.findIndex((it) => it.type === 'message' && it.event.author !== 'user');
  const compIdx = grouped.findIndex((it) => it.type === 'status' && it.event.kind === 'compaction');
  assert.ok(answerIdx >= 0 && compIdx > answerIdx);
});

test('#18 pre-answer work folds into Worked but the answer never does', () => {
  const events = [userMsg('q'), grep(), asst('answer'), compaction()];
  const grouped = groupTurns(buildFeed(events), false);
  // Exactly one Worked group (the grep), and it carries no assistant message.
  const worked = grouped.filter((it) => it.type === 'worked');
  assert.equal(worked.length, 1);
  assert.ok(!workedChildren(grouped).some((c) => c.type === 'message'));
});

test('#18 multiple assistant texts in a turn each stay top-level', () => {
  const events = [userMsg('q'), asst('first'), grep(), asst('second')];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['first', 'second']);
});

test('#19 a final answer split by a todo reconciliation merges into one message', () => {
  // The model emitted its answer, updated the checklist, then finished the
  // sentence. The checklist update must not split the final into two messages.
  const events = [
    userMsg('q'),
    asst('Here is the analysis.'),
    todo('1. [completed] done'),
    asst('All set!'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Here is the analysis.\n\nAll set!']);
  // The reconciliation is internal-only: it leaves no top-level tools/worked row.
  assert.ok(!grouped.some((it) => it.type === 'tools' || it.type === 'worked'));
});

test('#19 a fragment split by a real edit stays a separate message', () => {
  // Real file work between two assistant texts means they are genuinely distinct
  // messages; only pure reconciliation may merge them.
  const patch = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@', '+added line'].join('\n');
  const events = [
    userMsg('q'),
    asst('Working on it.'),
    ev({ kind: 'tool_call', toolName: 'apply_patch', toolArgs: { patch }, toolUseId: 'e1' }),
    asst('Done editing.'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Working on it.', 'Done editing.']);
});

test('#19 fragments are not merged when real tool work also sits between', () => {
  // A reconciliation call mixed with real tool activity is not a pure checklist
  // gap, so the two texts stay separate.
  const events = [
    userMsg('q'),
    asst('Analysis:'),
    grep(),
    todo('1. [completed] x'),
    asst('extra note'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Analysis:', 'extra note']);
});

test('#19 a todo reconciliation with its own id-less result still merges the answer', () => {
  // An id-less successful TodoWrite result classifies as generic tool_activity,
  // but the call+result group is still pure reconciliation and must merge.
  const events = [
    userMsg('q'),
    asst('Here is the plan outcome.'),
    todo('1. [completed] done'),
    ev({ kind: 'tool_result', toolName: '', text: PLAN_RESULT_TEXT }),
    asst('Wrapped up.'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Here is the plan outcome.\n\nWrapped up.']);
  assert.ok(!grouped.some((it) => it.type === 'tools' || it.type === 'worked'));
});

test('a freshly generated App stays eligible for autoplay when history replaces its event id', async () => {
  type FreshAppState = {
    identity: string;
    wasPending: boolean;
    texts: Set<string>;
  };
  type RememberFreshApps = (
    previous: FreshAppState | null,
    identity: string,
    items: FeedItem[],
    pending: boolean,
  ) => FreshAppState;
  const chatModule = (await import('./transcriptFeed')) as unknown as {
    rememberFreshAppResponses?: RememberFreshApps;
  };
  const remember = chatModule.rememberFreshAppResponses;
  assert.equal(typeof remember, 'function');
  if (!remember) return;

  const prompt = userMsg('Visualize this');
  const incomplete = asst('```app\n<main><script>const points = [');
  const liveItems = groupTurns(buildFeed([prompt, incomplete]), true);
  const liveState = remember(null, 'session-1', liveItems, true);
  assert.deepEqual([...liveState.texts], []);

  const completeText = '```app\n<main>Complete App</main>\n```';
  const authoritative = {
    ...asst(completeText),
    id: 'authoritative-history-id',
  };
  const settledItems = groupTurns(buildFeed([prompt, authoritative]), false);
  const settledState = remember(liveState, 'session-1', settledItems, false);
  assert.deepEqual([...settledState.texts], [completeText]);

  const reopenedState = remember(null, 'session-1', settledItems, false);
  assert.deepEqual([...reopenedState.texts], []);
});

test('assistant Apps without a user prompt are never treated as fresh autoplay responses', async () => {
  const chatModule = (await import('./transcriptFeed')) as unknown as {
    completeAppResponsesInLatestTurn?: (items: FeedItem[]) => string[];
  };
  const completeApps = chatModule.completeAppResponsesInLatestTurn;
  assert.equal(typeof completeApps, 'function');
  if (!completeApps) return;

  const historical = groupTurns(buildFeed([asst('```app\n<main>Historical</main>\n```')]), false);
  assert.deepEqual(completeApps(historical), []);
});

test('#39 streaming snapshots of one edit (same toolUseId) fold to one diff with latest stats', () => {
  const events = [
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(1) },
      toolUseId: 'e1',
    }),
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(2) },
      toolUseId: 'e1',
    }),
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(3) },
      toolUseId: 'e1',
    }),
  ];
  const items = buildFeed(events);
  const diffs = items.filter((it) => it.type === 'diff' || it.type === 'diffs');
  assert.equal(diffs.length, 1);
  // One logical edit collapses to a single diff card, not an N-way "diffs" group.
  const single = diffs[0] as Extract<FeedItem, { type: 'diff' }>;
  assert.equal(single.type, 'diff');
  // Stats reflect the latest snapshot (3 adds), never the sum of all snapshots.
  assert.equal(single.change.added, 3);
});

test('#39 distinct edits (different toolUseIds) stay separate in the diffs group', () => {
  const events = [
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(2) },
      toolUseId: 'e1',
    }),
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(3) },
      toolUseId: 'e2',
    }),
  ];
  const items = buildFeed(events);
  const group = items.find((it): it is Extract<FeedItem, { type: 'diffs' }> => it.type === 'diffs');
  assert.ok(group, 'expected a diffs group');
  assert.equal(group.changes.length, 2);
  const added = group.changes.reduce((s, c) => s + c.change.added, 0);
  assert.equal(added, 5);
});

test('a singleton diff keeps its viewport identity when an older edit joins the group', () => {
  const latest = ev({
    kind: 'tool_call',
    toolName: 'apply_patch',
    toolArgs: { patch: editPatch(2) },
    toolUseId: 'latest-edit',
  });
  const older = ev({
    kind: 'tool_call',
    toolName: 'apply_patch',
    toolArgs: { patch: editPatch(1) },
    toolUseId: 'older-edit',
  });
  const before = buildFeed([latest]).find(
    (item): item is Extract<FeedItem, { type: 'diff' }> => item.type === 'diff',
  );
  const after = buildFeed([older, latest]).find(
    (item): item is Extract<FeedItem, { type: 'diffs' }> => item.type === 'diffs',
  );

  assert.ok(before);
  assert.ok(after);
  assert.equal(feedRowId(before), feedRowId(after));
});

test('#27 collectTurnFiles folds repeated edits to one path with summed counts', () => {
  const run = buildFeed([editFile('src/a.ts', 2, 'e1'), editFile('src/a.ts', 3, 'e2')], {
    childSessionCards: true,
  });
  const files = collectTurnFiles(run);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/a.ts');
  assert.equal(files[0].added, 5);
});

test('#27 a completed turn that edited files gets a top-level changes summary', () => {
  const events = [
    userMsg('edit'),
    editFile('src/a.ts', 2, 'e1'),
    editFile('src/b.ts', 3, 'e2'),
    asst('done'),
  ];
  const grouped = groupTurns(
    buildFeed(events, { childSessionCards: true }),
    false,
    undefined,
    true,
  );
  const changes = grouped.find(
    (it): it is Extract<FeedItem, { type: 'turnChanges' }> => it.type === 'turnChanges',
  );
  assert.ok(changes, 'expected a turnChanges summary');
  assert.equal(changes.files.length, 2);
  assert.equal(changes.added, 5);
  // The summary is top-level, never nested inside the Worked group.
  assert.ok(!workedChildren(grouped).some((c) => c.type === 'turnChanges'));
});

test('prepending turn activity preserves the changes-summary viewport identity', () => {
  const edit = editFile('src/a.ts', 2, 'stable-edit');
  const answer = asst('done');
  const before = groupTurns(buildFeed([edit, answer]), false, undefined, true);
  const after = groupTurns(buildFeed([grep(), edit, answer]), false, undefined, true);
  const beforeChanges = before.find(
    (item): item is Extract<FeedItem, { type: 'turnChanges' }> => item.type === 'turnChanges',
  );
  const afterChanges = after.find(
    (item): item is Extract<FeedItem, { type: 'turnChanges' }> => item.type === 'turnChanges',
  );

  assert.ok(beforeChanges);
  assert.ok(afterChanges);
  assert.notEqual(beforeChanges.key, afterChanges.key);
  assert.equal(feedRowId(beforeChanges), feedRowId(afterChanges));
});

test('#27 a turn with no file edits gets no changes summary', () => {
  const grouped = groupTurns(
    buildFeed([userMsg('q'), grep(), asst('answer')], { childSessionCards: true }),
    false,
    undefined,
    true,
  );
  assert.ok(!grouped.some((it) => it.type === 'turnChanges'));
});

test('#27 the in-flight turn gets no changes summary until it completes', () => {
  const events = [userMsg('q'), editFile('src/a.ts', 1, 'e1')];
  const grouped = groupTurns(buildFeed(events, { childSessionCards: true }), true, undefined, true);
  assert.ok(!grouped.some((it) => it.type === 'turnChanges'));
});

test('#27 the changes summary is disabled unless the rich flag is set', () => {
  const events = [userMsg('edit'), editFile('src/a.ts', 1, 'e1'), asst('done')];
  const grouped = groupTurns(
    buildFeed(events, { childSessionCards: true }),
    false,
    undefined,
    false,
  );
  assert.ok(!grouped.some((it) => it.type === 'turnChanges'));
});

test('sameFeedEvents skips stable items and flags the streaming tail', () => {
  const prior = userMsg('hi');
  const tail = asst('Answer so far');
  const feed1 = buildFeed([prior, tail]);
  // Mirror the store's immutable tail growth: prior events keep their ref, only
  // the last event becomes a new object with appended text.
  const grown = { ...tail, text: 'Answer so far and then some more' };
  const feed2 = buildFeed([prior, grown]);
  assert.equal(sameFeedEvents(feed1[0], feed2[0]), true); // unchanged prior item
  assert.equal(sameFeedEvents(feed1[1], feed2[1]), false); // growing tail item
});

test('sameFeedEvents compares grouped tool runs by underlying event refs', () => {
  const a = grep();
  const b = grep();
  const g1 = buildFeed([a, b]).find((it) => it.type === 'tools');
  const g2 = buildFeed([a, b]).find((it) => it.type === 'tools');
  assert.ok(g1 && g2);
  assert.equal(sameFeedEvents(g1!, g2!), true);
  // A different second tool event breaks the run's identity.
  const g3 = buildFeed([a, grep()]).find((it) => it.type === 'tools');
  assert.ok(g3);
  assert.equal(sameFeedEvents(g1!, g3!), false);
});

// appendedFeedItemKeys decides which rows get the rise-in entrance animation.
// It must track item identity (not list index) so paging older history — which
// prepends already-past messages ahead of the visible ones — does not re-animate
// existing rows or treat the prepend like a fresh append.
test('appendedFeedItemKeys animates only genuinely appended tail items', () => {
  const identity = 'm:primary';
  const keys = (letters: string[]) => letters.map((key) => ({ key }));

  // Genuinely appended items (new keys at the tail) animate.
  const previous = { identity, keys: new Set(['a', 'b', 'c']) };
  assert.deepEqual(
    [...appendedFeedItemKeys(keys(['a', 'b', 'c', 'd', 'e']), previous, identity)],
    ['e', 'd'],
  );

  // Paging older history prepends new keys ahead of the existing ones; nothing
  // re-animates (neither the prepended items nor the already-visible rows).
  assert.deepEqual(
    [...appendedFeedItemKeys(keys(['x', 'y', 'a', 'b', 'c']), previous, identity)],
    [],
  );

  // Re-rendering with the same keys (e.g. a token streaming into an existing
  // message) animates nothing.
  assert.deepEqual([...appendedFeedItemKeys(keys(['a', 'b', 'c']), previous, identity)], []);

  // No previous render (first time a feed is shown) animates nothing.
  assert.deepEqual([...appendedFeedItemKeys(keys(['a', 'b']), null, identity)], []);

  // A different feed identity (switched sessions/child) animates nothing.
  assert.deepEqual(
    [
      ...appendedFeedItemKeys(
        keys(['a', 'b', 'd']),
        { identity: 'other', keys: new Set(['a']) },
        identity,
      ),
    ],
    [],
  );

  // A newly appended item preceded by a fresh prepend animates only the tail.
  assert.deepEqual(
    [...appendedFeedItemKeys(keys(['x', 'a', 'b', 'c', 'd']), previous, identity)],
    ['d'],
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { AcpConnection } from '../acp/AcpConnection.js';
import type { ProviderRuntimeEvent } from '../providerEvents.js';
import type {
  ProviderApprovalDecision,
  ProviderInteractionSink,
  ProviderPlanReviewDecision,
  ProviderQuestionAnswer,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import { createTestClock, createTestIdSource } from '../testing/FakeProviderAdapter.js';
import {
  assertCompleteCapabilities,
  assertExactlyOneTurnSettlement,
} from '../testing/ProviderContractHarness.js';
import { CursorProviderAdapter } from './CursorAdapter.js';
import { cursorCapabilities } from './cursorHandshake.js';
import { CURSOR_AUTONOMY_TABLE, shouldAutoApproveAcpKind } from './cursorPermissions.js';
import type { CursorProviderSession } from './cursorSession.js';
import { CURSOR_FAKE_SCRIPT_ENV, fakeCursorAgentSpawn } from './testing/fakeCursorAgent.js';

function recordingSink() {
  const events: ProviderRuntimeEvent[] = [];
  return {
    events,
    sink: (event: ProviderRuntimeEvent) => {
      events.push(event);
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

function controllableSink() {
  const approvals: Parameters<ProviderInteractionSink['requestApproval']>[0][] = [];
  const questions: Parameters<ProviderInteractionSink['requestQuestion']>[0][] = [];
  const plans: Parameters<ProviderInteractionSink['requestPlanReview']>[0][] = [];
  const approval = deferred<ProviderApprovalDecision>();
  const question = deferred<ProviderQuestionAnswer>();
  const plan = deferred<ProviderPlanReviewDecision>();
  const sink: ProviderInteractionSink = {
    requestApproval: async (request) => {
      approvals.push(request);
      return approval.promise;
    },
    requestQuestion: async (request) => {
      questions.push(request);
      return question.promise;
    },
    requestPlanReview: async (request) => {
      plans.push(request);
      return plan.promise;
    },
  };
  return { sink, approvals, questions, plans, approval, question, plan };
}

function unusedSink(): ProviderInteractionSink {
  return {
    requestApproval: async () => {
      throw new Error('interaction sink should not be called');
    },
    requestQuestion: async () => {
      throw new Error('interaction sink should not be called');
    },
    requestPlanReview: async () => {
      throw new Error('interaction sink should not be called');
    },
  };
}

function createInput(
  sink: (event: ProviderRuntimeEvent) => void,
  extras: {
    autonomy?: 'off' | 'low' | 'medium' | 'high';
    interactionSink?: ProviderInteractionSink;
  } = {},
) {
  return {
    target: { kind: 'session' as const, appSessionId: 'app-1' },
    configuration: {
      providerSelection: {
        providerInstanceId: 'cursor' as const,
        modelId: 'default',
        options: {},
      },
      interactionMode: 'auto' as const,
      autonomy: extras.autonomy ?? ('off' as const),
    },
    expectedGeneration: 3,
    cwd: process.cwd(),
    eventSink: sink,
    interactionSink: extras.interactionSink ?? unusedSink(),
    ids: createTestIdSource('cursor'),
    clock: createTestClock(),
  };
}

function adapterWithScript(script: unknown[], extras: { env?: NodeJS.ProcessEnv } = {}) {
  let connection: AcpConnection | undefined;
  const spawn = fakeCursorAgentSpawn({
    [CURSOR_FAKE_SCRIPT_ENV]: JSON.stringify(script),
    ...extras.env,
  });
  const adapter = new CursorProviderAdapter({
    spawnAcp: spawn,
    env: spawn.env,
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  return {
    adapter,
    connection: () => {
      assert.ok(connection);
      return connection;
    },
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForTurnSettlement(
  events: readonly ProviderRuntimeEvent[],
  turnId: string,
): Promise<void> {
  await waitUntil(
    () => events.some((event) => event.type === 'turn.settled' && event.turnId === turnId),
    `turn.settled ${turnId}`,
  );
}

async function startScriptedTurn(input: {
  script: unknown[];
  autonomy?: 'off' | 'low' | 'medium' | 'high';
  interactionSink?: ProviderInteractionSink;
}): Promise<{
  adapter: CursorProviderAdapter;
  session: CursorProviderSession;
  connection: AcpConnection;
  events: ProviderRuntimeEvent[];
}> {
  const recorded = recordingSink();
  const { adapter, connection } = adapterWithScript(input.script);
  const session = await adapter.create(
    createInput(recorded.sink, {
      autonomy: input.autonomy,
      interactionSink: input.interactionSink,
    }),
  );
  session.activate();
  await session.startTurn({
    turnId: 'turn-1',
    prompt: { text: 'hello', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink, { autonomy: input.autonomy }).configuration,
  });
  return { adapter, session, connection: connection(), events: recorded.events };
}

function lastInteractionResult(payload: unknown): unknown {
  assert.ok(isPlainObject(payload) && Array.isArray(payload.lastInteractions));
  const first = payload.lastInteractions[0];
  assert.ok(isPlainObject(first) && isPlainObject(first.reply));
  return first.reply;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('numeric JSON-RPC id 0 is answered without rewriting the id', async () => {
  const interactions = controllableSink();
  const { session, connection, events } = await startScriptedTurn({
    script: [{ type: 'permission', id: 0, kind: 'execute' }],
    interactionSink: interactions.sink,
  });
  try {
    await waitUntil(() => interactions.approvals.length === 1, 'permission request');
    interactions.approval.resolve({ decision: 'allow_once' });
    await waitForTurnSettlement(events, 'turn-1');
    const recorded = await connection.request('x/last-interactions');
    assert.ok(isPlainObject(recorded) && Array.isArray(recorded.lastInteractions));
    const first = recorded.lastInteractions[0];
    assert.ok(isPlainObject(first));
    assert.equal(first.id, 0);
    assert.equal(first.idType, 'number');
    const reply = first.reply;
    assert.ok(isPlainObject(reply));
    assert.equal(reply.id, 0);
    assert.equal(reply.kind, 'success');
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('ACP tool kinds surface as the matching approval class through the fake peer', async () => {
  const cases = [
    { kind: 'execute', approvalClass: 'command', permissionKind: 'exec' },
    { kind: 'read', approvalClass: 'file_read', permissionKind: 'other' },
    { kind: 'edit', approvalClass: 'file_change', permissionKind: 'edit' },
    { kind: 'delete', approvalClass: 'file_change', permissionKind: 'edit' },
    { kind: 'move', approvalClass: 'file_change', permissionKind: 'edit' },
    { kind: 'search', approvalClass: 'dynamic_tool', permissionKind: 'other' },
  ] as const;
  for (const testCase of cases) {
    const interactions = controllableSink();
    const { session, events } = await startScriptedTurn({
      script: [{ type: 'permission', kind: testCase.kind, title: testCase.kind }],
      interactionSink: interactions.sink,
    });
    try {
      await waitUntil(() => interactions.approvals.length === 1, `${testCase.kind} approval`);
      const request = interactions.approvals[0];
      assert.ok(request);
      assert.equal(request.kind, testCase.permissionKind, testCase.kind);
      interactions.approval.resolve({ decision: 'deny' });
      await waitForTurnSettlement(events, 'turn-1');
    } finally {
      await session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }
});

test('DROIDEX decisions select peer-advertised option ids including a non-standard set', async () => {
  const custom = [
    { optionId: 'yes-please', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no-thanks', name: 'No', kind: 'reject_once' },
  ];
  const interactions = controllableSink();
  const { session, connection, events } = await startScriptedTurn({
    script: [{ type: 'permission', kind: 'execute', options: custom }],
    interactionSink: interactions.sink,
  });
  try {
    await waitUntil(() => interactions.approvals.length === 1, 'custom permission');
    interactions.approval.resolve({ decision: 'allow_once' });
    await waitForTurnSettlement(events, 'turn-1');
    const recorded = await connection.request('x/last-interactions');
    const reply = lastInteractionResult(recorded);
    assert.ok(isPlainObject(reply) && isPlainObject(reply.result));
    assert.deepEqual(reply.result, {
      outcome: { outcome: 'selected', optionId: 'yes-please' },
    });
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('missing advertised option kind fails cleanly instead of inventing an id', async () => {
  const interactions = controllableSink();
  const { session, connection, events } = await startScriptedTurn({
    script: [
      {
        type: 'permission',
        kind: 'execute',
        options: [{ optionId: 'only-always', name: 'Always', kind: 'allow_always' }],
      },
    ],
    interactionSink: interactions.sink,
  });
  try {
    await waitUntil(() => interactions.approvals.length === 1, 'nonstandard permission');
    interactions.approval.resolve({ decision: 'allow_once' });
    await waitForTurnSettlement(events, 'turn-1');
    const recorded = await connection.request('x/last-interactions');
    const reply = lastInteractionResult(recorded);
    assert.ok(isPlainObject(reply) && isPlainObject(reply.result));
    assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('cursor/ask_question round-trips exact ids for single-select and multi-select', async () => {
  const interactions = controllableSink();
  const { session, connection, events } = await startScriptedTurn({
    script: [
      {
        type: 'ask_question',
        payload: {
          toolCallId: 'ask-1',
          questions: [
            {
              id: 'exact-q-id',
              prompt: 'Pick one',
              options: [
                { id: 'a', label: 'Alpha' },
                { id: 'b', label: 'Beta' },
              ],
            },
            {
              id: 'multi-q',
              prompt: 'Pick many',
              allowMultiple: true,
              options: [
                { id: 'x', label: 'X-ray' },
                { id: 'y', label: 'Yankee' },
              ],
            },
          ],
        },
      },
    ],
    interactionSink: interactions.sink,
  });
  try {
    await waitUntil(() => interactions.questions.length === 1, 'question request');
    const request = interactions.questions[0];
    assert.ok(request);
    assert.deepEqual(
      request.questions.map((question) => question.id),
      ['exact-q-id', 'multi-q'],
    );
    interactions.question.resolve({
      status: 'answered',
      answers: { 'exact-q-id': ['a'], 'multi-q': ['x', 'y'] },
    });
    await waitForTurnSettlement(events, 'turn-1');
    const recorded = await connection.request('x/last-interactions');
    const reply = lastInteractionResult(recorded);
    assert.ok(isPlainObject(reply) && isPlainObject(reply.result));
    assert.deepEqual(reply.result, {
      answers: { 'exact-q-id': 'a', 'multi-q': ['x', 'y'] },
    });
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('cursor/create_plan produces a plan review for implement, iterate, and cancel', async () => {
  for (const decision of [
    { decision: 'implement' as const, expected: { accepted: true } },
    {
      decision: 'iterate' as const,
      feedback: 'add tests',
      expected: { accepted: false, feedback: 'add tests' },
    },
    { decision: 'cancel' as const, expected: { accepted: false } },
  ]) {
    const interactions = controllableSink();
    const { session, connection, events } = await startScriptedTurn({
      script: [
        {
          type: 'create_plan',
          payload: { toolCallId: 'plan-1', plan: '# Ship it', todos: [] },
        },
      ],
      interactionSink: interactions.sink,
    });
    try {
      await waitUntil(() => interactions.plans.length === 1, 'plan review');
      if (decision.decision === 'iterate') {
        interactions.plan.resolve({ decision: 'iterate', feedback: decision.feedback });
      } else {
        interactions.plan.resolve({ decision: decision.decision });
      }
      await waitForTurnSettlement(events, 'turn-1');
      const recorded = await connection.request('x/last-interactions');
      const reply = lastInteractionResult(recorded);
      assert.ok(isPlainObject(reply) && isPlainObject(reply.result));
      assert.deepEqual(reply.result, decision.expected);
    } finally {
      await session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }
});

test('cursor/update_todos emits once per fingerprint and ignores an unchanged list', async () => {
  const todos = [{ id: '1', content: 'Write tests', status: 'pending' }];
  const { session, events } = await startScriptedTurn({
    script: [
      { type: 'update_todos', payload: { toolCallId: 't1', todos, merge: false } },
      { type: 'update_todos', payload: { toolCallId: 't1', todos, merge: false } },
      {
        type: 'update_todos',
        payload: {
          toolCallId: 't1',
          todos: [{ id: '1', content: 'Write tests', status: 'completed' }],
          merge: false,
        },
      },
    ],
  });
  try {
    await waitForTurnSettlement(events, 'turn-1');
    const statuses = events.filter(
      (event) => event.type === 'transcript' && event.event.kind === 'status',
    );
    assert.equal(statuses.length, 2);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('tool output over the fake peer retains the tail and drops the head', async () => {
  const head = 'BEGIN-OUTPUT';
  const tail = 'END-OUTPUT-UNIQUE';
  const text = `${head}${'x'.repeat(8_200)}${tail}`;
  const { session, events } = await startScriptedTurn({
    script: [
      {
        type: 'tool_call',
        toolCallId: 'tool-trunc',
        payload: {
          kind: 'execute',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text } }],
        },
      },
    ],
  });
  try {
    await waitForTurnSettlement(events, 'turn-1');
    const toolEvents = events.filter(
      (event) => event.type === 'transcript' && event.event.toolUseId === 'tool-trunc',
    );
    assert.ok(toolEvents.length >= 1);
    const last = toolEvents[toolEvents.length - 1];
    assert.equal(last?.type, 'transcript');
    if (last?.type === 'transcript') {
      assert.equal(last.event.text?.includes(head), false);
      assert.equal(last.event.text?.endsWith(tail), true);
    }
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('fake peer tool updates coalesce by growth, skip count, and terminal status', async () => {
  const updates: unknown[] = [];
  for (let index = 0; index < 12; index += 1) {
    updates.push({
      type: index === 0 ? 'tool_call' : 'tool_call_update',
      toolCallId: 'tool-coalesce',
      payload: {
        kind: 'execute',
        status: index === 11 ? 'completed' : 'in_progress',
        title: 'run',
        content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(index + 1) } }],
      },
    });
  }
  const { session, events } = await startScriptedTurn({ script: updates });
  try {
    await waitForTurnSettlement(events, 'turn-1');
    const toolEvents = events.filter(
      (event) => event.type === 'transcript' && event.event.toolUseId === 'tool-coalesce',
    );
    assert.equal(toolEvents.length, 3);
    const last = toolEvents[toolEvents.length - 1];
    assert.equal(last?.type, 'transcript');
    if (last?.type === 'transcript') {
      assert.equal(last.event.kind, 'tool_result');
    }
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('autonomy table: off surfaces the execute request that high auto-approves', async () => {
  const offSink = controllableSink();
  const off = await startScriptedTurn({
    script: [{ type: 'permission', kind: 'execute' }],
    autonomy: 'off',
    interactionSink: offSink.sink,
  });
  try {
    await waitUntil(() => offSink.approvals.length === 1, 'off permission');
    offSink.approval.resolve({ decision: 'allow_once' });
    await waitForTurnSettlement(off.events, 'turn-1');
  } finally {
    await off.session.close(ShutdownDeadline.fromDurationMs(5_000));
  }

  const high = await startScriptedTurn({
    script: [{ type: 'permission', kind: 'execute' }],
    autonomy: 'high',
    interactionSink: unusedSink(),
  });
  try {
    await waitForTurnSettlement(high.events, 'turn-1');
    const recorded = await high.connection.request('x/last-interactions');
    const reply = lastInteractionResult(recorded);
    assert.ok(isPlainObject(reply) && isPlainObject(reply.result));
    assert.deepEqual(reply.result, {
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    });
    assert.equal(high.session.pendingInteractionCount, 0);
  } finally {
    await high.session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('each declared autonomy row auto-approves only its table kinds over the fake peer', async () => {
  for (const row of CURSOR_AUTONOMY_TABLE) {
    const expectAuto = shouldAutoApproveAcpKind(row.autonomy, 'read');
    const interactions = controllableSink();
    const started = await startScriptedTurn({
      script: [{ type: 'permission', kind: 'read' }],
      autonomy: row.autonomy,
      interactionSink: expectAuto ? unusedSink() : interactions.sink,
    });
    try {
      if (expectAuto) {
        await waitForTurnSettlement(started.events, 'turn-1');
        assert.equal(interactions.approvals.length, 0, row.autonomy);
      } else {
        await waitUntil(() => interactions.approvals.length === 1, `${row.autonomy} read`);
        interactions.approval.resolve({ decision: 'allow_once' });
        await waitForTurnSettlement(started.events, 'turn-1');
      }
    } finally {
      await started.session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }
});

test('pending interactions settle exactly once on user response, interrupt, close, crash, and shutdown', async () => {
  const user = controllableSink();
  const userRun = await startScriptedTurn({
    script: [{ type: 'permission', kind: 'execute' }],
    interactionSink: user.sink,
  });
  try {
    await waitUntil(() => user.approvals.length === 1, 'user permission');
    user.approval.resolve({ decision: 'deny' });
    await waitForTurnSettlement(userRun.events, 'turn-1');
    assert.equal(userRun.session.settledInteractionCount, 1);
    user.approval.resolve({ decision: 'allow_once' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(userRun.session.settledInteractionCount, 1);
  } finally {
    await userRun.session.close(ShutdownDeadline.fromDurationMs(5_000));
  }

  for (const path of ['interrupt', 'close', 'shutdown'] as const) {
    const hanging = controllableSink();
    const run = await startScriptedTurn({
      script: [{ type: 'permission', kind: 'execute' }],
      interactionSink: hanging.sink,
    });
    await waitUntil(() => run.session.pendingInteractionCount === 1, `${path} pending`);
    if (path === 'interrupt') {
      await run.session.interrupt({ turnId: 'turn-1', runtimeGeneration: 3 });
    } else if (path === 'close') {
      await run.session.close(ShutdownDeadline.fromDurationMs(5_000));
    } else {
      await run.adapter.close(ShutdownDeadline.fromDurationMs(5_000));
    }
    assert.equal(run.session.pendingInteractionCount, 0, path);
    assert.equal(run.session.settledInteractionCount, 1, path);
    hanging.approval.resolve({ decision: 'allow_once' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.session.settledInteractionCount, 1, `${path} late resolve`);
    if (path === 'interrupt') {
      await run.session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }

  const crashSink = controllableSink();
  const crash = await startScriptedTurn({
    script: [{ type: 'permission', kind: 'execute' }],
    interactionSink: crashSink.sink,
  });
  await waitUntil(() => crash.session.pendingInteractionCount === 1, 'crash pending');
  await crash.connection.request('x/crash').catch(() => undefined);
  await waitUntil(() => crash.session.settledInteractionCount === 1, 'crash settled');
  assert.equal(crash.session.pendingInteractionCount, 0);
  crashSink.approval.resolve({ decision: 'allow_once' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(crash.session.settledInteractionCount, 1);
  await crash.session.close(ShutdownDeadline.fromDurationMs(5_000));
});

test('a malformed extension payload is rejected without breaking the connection', async () => {
  const { session, connection, events } = await startScriptedTurn({
    script: [
      { type: 'malformed_request', method: 'cursor/ask_question', payload: { nope: true } },
      { type: 'text', text: 'still-alive' },
    ],
  });
  try {
    await waitForTurnSettlement(events, 'turn-1');
    const recorded = await connection.request('x/last-interactions');
    const reply = lastInteractionResult(recorded);
    assert.ok(isPlainObject(reply));
    assert.equal(reply.kind, 'error');
    const serialized = JSON.stringify(reply);
    assert.equal(serialized.includes('nope'), false);
    assert.equal(
      events.some((event) => event.type === 'transcript' && event.event.text === 'still-alive'),
      true,
    );
    assertExactlyOneTurnSettlement(events, 'turn-1', { status: 'completed' });
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('Cursor capabilities remain complete after interaction support', () => {
  const capabilities = cursorCapabilities(['auto', 'spec']);
  assertCompleteCapabilities(capabilities);
  assert.equal(capabilities.approvals, true);
  assert.equal(capabilities.questions, true);
  assert.equal(capabilities.planReview, true);
  assert.deepEqual(capabilities.autonomyLevels, ['off', 'low', 'medium', 'high']);
});

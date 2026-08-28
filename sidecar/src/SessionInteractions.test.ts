import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from './protocol.js';
import { SessionInteractions } from './SessionInteractions.js';
import type { SessionTarget } from './providers/providerIdentity.js';
import type {
  ProviderApprovalRequest,
  ProviderPlanReviewRequest,
  ProviderQuestionRequest,
} from './providers/providerTypes.js';

const SENTINEL = 'SENTINEL_NATIVE_PAYLOAD_DO_NOT_CROSS_BRIDGE';

function createHarness() {
  const emitted: ServerEvent[] = [];
  const errors: Array<Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>> = [];
  const interactions = new SessionInteractions({
    emit: (event) => {
      emitted.push(event);
    },
    emitError: (error) => {
      errors.push(error);
    },
  });
  return { emitted, errors, interactions };
}

function sessionTarget(appSessionId: string): SessionTarget {
  return { kind: 'session', appSessionId };
}

function approvalInput(
  appSessionId: string,
  requestId: string,
  extras: Partial<ProviderApprovalRequest> = {},
): ProviderApprovalRequest {
  return {
    requestId,
    target: sessionTarget(appSessionId),
    runtimeGeneration: 1,
    kind: 'exec',
    title: 'Run command',
    detail: 'pwd',
    ...extras,
  };
}

function questionInput(
  appSessionId: string,
  requestId: string,
  extras: Partial<ProviderQuestionRequest> = {},
): ProviderQuestionRequest {
  return {
    requestId,
    target: sessionTarget(appSessionId),
    runtimeGeneration: 1,
    questions: [
      {
        id: 'q1',
        prompt: 'Pick one',
        options: ['a', 'b'],
        multiSelect: false,
      },
    ],
    ...extras,
  };
}

function planInput(
  appSessionId: string,
  requestId: string,
  extras: Partial<ProviderPlanReviewRequest> = {},
): ProviderPlanReviewRequest {
  return {
    requestId,
    target: sessionTarget(appSessionId),
    runtimeGeneration: 1,
    plan: 'Ship it.',
    ...extras,
  };
}

function approvalRequests(events: ServerEvent[]) {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'approval.requested' }> =>
      event.type === 'approval.requested',
  );
}

function questionRequests(events: ServerEvent[]) {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'question.requested' }> =>
      event.type === 'question.requested',
  );
}

function planRequests(events: ServerEvent[]) {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'plan_review.requested' }> =>
      event.type === 'plan_review.requested',
  );
}

function collectedStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const strings: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) strings.push(...collectedStrings(item, seen));
    return strings;
  }
  for (const [key, nested] of Object.entries(value)) {
    strings.push(key);
    strings.push(...collectedStrings(nested, seen));
  }
  return strings;
}

test('equal native request ids from two sessions stay distinct', async () => {
  const harness = createHarness();
  const first = harness.interactions.requestApproval(approvalInput('app-1', 'native-1'));
  const second = harness.interactions.requestApproval(approvalInput('app-2', 'native-1'));
  const requests = approvalRequests(harness.emitted);

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.request.appSessionId, 'app-1');
  assert.equal(requests[1]?.request.appSessionId, 'app-2');
  assert.notEqual(requests[0]?.request.requestId, requests[1]?.request.requestId);
  assert.match(requests[0]?.request.requestId ?? '', /app-1:native-1/);
  assert.match(requests[1]?.request.requestId ?? '', /app-2:native-1/);

  harness.interactions.respondToApproval(
    'app-1',
    requests[0]?.request.requestId ?? '',
    'proceed_once',
  );
  assert.deepEqual(await first, { decision: 'allow_once' });
  await Promise.resolve();
  const secondState = await Promise.race([
    second.then((decision) => ({ settled: true, decision })),
    Promise.resolve({ settled: false, decision: undefined }),
  ]);
  assert.equal(secondState.settled, false);

  harness.interactions.respondToApproval('app-2', requests[1]?.request.requestId ?? '', 'cancel');
  assert.deepEqual(await second, { decision: 'cancel' });
});

test('invalid approval outcomes are rejected and leave the request pending', async () => {
  const harness = createHarness();
  let settled = false;
  const pending = harness.interactions
    .requestApproval(approvalInput('app-1', 'native-1'))
    .then((decision) => {
      settled = true;
      return decision;
    });
  const requestId = approvalRequests(harness.emitted)[0]?.request.requestId ?? '';

  harness.interactions.respondToApproval('app-1', requestId, 'not-an-outcome');
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(harness.errors[0]?.code, 'permission.invalid_outcome');

  harness.interactions.respondToApproval('app-1', requestId, 'cancel');
  assert.deepEqual(await pending, { decision: 'cancel' });
  assert.equal(settled, true);
});

test('unknown, duplicate, late, and wrong-session approvals settle at most once', async () => {
  const harness = createHarness();
  let settlements = 0;
  const pending = harness.interactions
    .requestApproval(approvalInput('app-1', 'native-1'))
    .then((decision) => {
      settlements += 1;
      return decision;
    });
  const requestId = approvalRequests(harness.emitted)[0]?.request.requestId ?? '';

  harness.interactions.respondToApproval('app-2', requestId, 'proceed_once');
  harness.interactions.respondToApproval('app-1', 'unknown', 'proceed_once');
  await Promise.resolve();
  assert.equal(settlements, 0);
  harness.interactions.respondToApproval('app-1', requestId, 'cancel');
  assert.deepEqual(await pending, { decision: 'cancel' });
  harness.interactions.respondToApproval('app-1', requestId, 'proceed_once');
  assert.equal(settlements, 1);
});

test('structured multi-question answers preserve exact keys', async () => {
  const harness = createHarness();
  const pending = harness.interactions.requestQuestion(
    questionInput('app-1', 'native-q', {
      questions: [
        { id: 'color', prompt: 'Color?', options: ['red', 'blue'], multiSelect: false },
        { id: 'tags', prompt: 'Tags?', options: ['a', 'b', 'c'], multiSelect: true },
      ],
    }),
  );
  const request = questionRequests(harness.emitted)[0]?.question;
  assert.ok(request);
  assert.deepEqual(request.questions, [
    { id: 'color', prompt: 'Color?', options: ['red', 'blue'], multiSelect: false },
    { id: 'tags', prompt: 'Tags?', options: ['a', 'b', 'c'], multiSelect: true },
  ]);

  harness.interactions.respondToQuestion('app-1', request.requestId, false, {
    color: ['blue'],
    tags: ['a', 'c'],
  });
  assert.deepEqual(await pending, {
    status: 'answered',
    answers: { color: ['blue'], tags: ['a', 'c'] },
  });
});

test('single-select and multi-select shapes reject invalid answer arrays', async () => {
  const harness = createHarness();
  const single = harness.interactions.requestQuestion(questionInput('app-1', 'single'));
  const singleId = questionRequests(harness.emitted)[0]?.question.requestId ?? '';
  harness.interactions.respondToQuestion('app-1', singleId, false, { q1: ['a', 'b'] });
  await Promise.resolve();
  assert.equal(harness.errors[0]?.code, 'question.invalid_answer');

  harness.interactions.respondToQuestion('app-1', singleId, false, { q1: ['a'] });
  assert.deepEqual(await single, { status: 'answered', answers: { q1: ['a'] } });

  const multi = harness.interactions.requestQuestion(
    questionInput('app-2', 'multi', {
      questions: [{ id: 'tags', prompt: 'Tags?', options: ['a', 'b'], multiSelect: true }],
    }),
  );
  const multiId = questionRequests(harness.emitted).at(-1)?.question.requestId ?? '';
  harness.interactions.respondToQuestion('app-2', multiId, false, { tags: [] });
  await Promise.resolve();
  assert.equal(harness.errors.at(-1)?.code, 'question.invalid_answer');
  harness.interactions.respondToQuestion('app-2', multiId, false, { tags: ['a', 'b'] });
  assert.deepEqual(await multi, { status: 'answered', answers: { tags: ['a', 'b'] } });
});

test('question cancellation, duplicate, late, and wrong-session responses settle once', async () => {
  const harness = createHarness();
  let settlements = 0;
  const pending = harness.interactions
    .requestQuestion(questionInput('app-1', 'native-q'))
    .then((answer) => {
      settlements += 1;
      return answer;
    });
  const requestId = questionRequests(harness.emitted)[0]?.question.requestId ?? '';

  harness.interactions.respondToQuestion('app-2', requestId, false, { q1: ['a'] });
  harness.interactions.respondToQuestion('app-1', 'unknown', true, {});
  await Promise.resolve();
  assert.equal(settlements, 0);
  harness.interactions.respondToQuestion('app-1', requestId, true, {});
  assert.deepEqual(await pending, { status: 'cancelled' });
  harness.interactions.respondToQuestion('app-1', requestId, false, { q1: ['a'] });
  assert.equal(settlements, 1);
});

test('plan review accepts implement, iterate with feedback, and cancel', async () => {
  const harness = createHarness();
  const implement = harness.interactions.requestPlanReview(planInput('app-1', 'plan-1'));
  const implementId = planRequests(harness.emitted)[0]?.request.requestId ?? '';
  harness.interactions.respondToPlanReview('app-1', implementId, { decision: 'implement' });
  assert.deepEqual(await implement, { decision: 'implement' });

  const iterate = harness.interactions.requestPlanReview(planInput('app-1', 'plan-2'));
  const iterateId = planRequests(harness.emitted).at(-1)?.request.requestId ?? '';
  harness.interactions.respondToPlanReview('app-1', iterateId, { decision: 'iterate' });
  await Promise.resolve();
  assert.equal(harness.errors[0]?.code, 'plan_review.invalid_decision');
  harness.interactions.respondToPlanReview('app-1', iterateId, {
    decision: 'iterate',
    feedback: 'Tighten the rollback.',
  });
  assert.deepEqual(await iterate, { decision: 'iterate', feedback: 'Tighten the rollback.' });

  const cancel = harness.interactions.requestPlanReview(planInput('app-1', 'plan-3'));
  const cancelId = planRequests(harness.emitted).at(-1)?.request.requestId ?? '';
  harness.interactions.respondToPlanReview('app-1', cancelId, { decision: 'cancel' });
  assert.deepEqual(await cancel, { decision: 'cancel' });
});

test('cancelAllPending settles every pending request as cancelled', async () => {
  const harness = createHarness();
  const approval = harness.interactions.requestApproval(approvalInput('app-1', 'a'));
  const question = harness.interactions.requestQuestion(questionInput('app-1', 'q'));
  const plan = harness.interactions.requestPlanReview(planInput('app-2', 'p'));
  await Promise.resolve();
  harness.interactions.cancelAllPending();
  assert.deepEqual(await approval, { decision: 'cancel' });
  assert.deepEqual(await question, { status: 'cancelled' });
  assert.deepEqual(await plan, { decision: 'cancel' });
  harness.interactions.cancelAllPending();
});

test('cancelSession settles one session and leaves the other pending', async () => {
  const harness = createHarness();
  const kept = harness.interactions.requestApproval(approvalInput('app-keep', 'native-1'));
  const crashed = harness.interactions.requestApproval(approvalInput('app-crash', 'native-1'));
  harness.interactions.cancelSession('app-crash');
  assert.deepEqual(await crashed, { decision: 'cancel' });
  const keptId = approvalRequests(harness.emitted).find(
    (event) => event.request.appSessionId === 'app-keep',
  )?.request.requestId;
  assert.ok(keptId);
  harness.interactions.respondToApproval('app-keep', keptId, 'proceed_once');
  assert.deepEqual(await kept, { decision: 'allow_once' });
});

test('replacement generation cancel settles the replaced session', async () => {
  const harness = createHarness();
  const pending = harness.interactions.requestApproval(
    approvalInput('app-1', 'native-1', { runtimeGeneration: 3 }),
  );
  harness.interactions.cancelSession('app-1');
  assert.deepEqual(await pending, { decision: 'cancel' });
});

test('forgetSession is protocol-silent, resolves nothing, and discards owned state', async () => {
  const harness = createHarness();
  let pendingSettled = false;
  void harness.interactions.requestApproval(approvalInput('app-1', 'pending')).then(() => {
    pendingSettled = true;
  });
  const eventCount = harness.emitted.length;
  const errorCount = harness.errors.length;
  harness.interactions.forgetSession('app-1');
  await Promise.resolve();
  assert.equal(pendingSettled, false);
  assert.equal(harness.emitted.length, eventCount);
  assert.equal(harness.errors.length, errorCount);

  const afterResume = harness.interactions.requestApproval(approvalInput('app-1', 'after-resume'));
  const request = approvalRequests(harness.emitted).at(-1);
  assert.ok(request);
  harness.interactions.respondToApproval('app-1', request.request.requestId, 'cancel');
  assert.deepEqual(await afterResume, { decision: 'cancel' });
});

test('serialized bridge events omit a sentinel native payload', async () => {
  const harness = createHarness();
  const input = approvalInput('app-1', 'native-1');
  (input as unknown as Record<string, unknown>)[SENTINEL] = {
    fileContents: SENTINEL,
    command: SENTINEL,
    token: SENTINEL,
  };
  const pending = harness.interactions.requestApproval(input);
  const event = approvalRequests(harness.emitted)[0];
  assert.ok(event);
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes(SENTINEL), false);
  assert.equal('raw' in event.request, false);
  const walked = collectedStrings(event);
  assert.equal(
    walked.some((value) => value.includes(SENTINEL)),
    false,
  );
  harness.interactions.respondToApproval('app-1', event.request.requestId, 'cancel');
  await pending;
});

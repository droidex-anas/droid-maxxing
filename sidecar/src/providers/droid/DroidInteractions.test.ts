import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type AskUserRequestParams,
  type RequestPermissionRequestParams,
  type UpdateSessionSettingsRequestParams,
} from '@factory/droid-sdk';

import { PERMISSION_OUTCOMES, type ServerEvent, type SessionSummary } from '../../protocol.js';
import { SessionInteractions } from '../../SessionInteractions.js';
import { droidSessionConfiguration } from '../providerIdentity.js';
import {
  createDroidNativeHandlers,
  DroidInteractions,
  type DroidInteractionLiveSession,
} from './DroidInteractions.js';

const SENTINEL = 'SENTINEL_NATIVE_PAYLOAD_DO_NOT_CROSS_BRIDGE';

function summary(appSessionId: string): SessionSummary {
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function permissionInput(toolUseId: string, command = 'pwd'): RequestPermissionRequestParams {
  return {
    toolUses: [
      {
        toolUse: {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command, [SENTINEL]: SENTINEL },
        },
        confirmationType: ToolConfirmationType.Execute,
        details: {
          type: ToolConfirmationType.Execute,
          fullCommand: command,
          command,
        },
      },
    ],
    options: [],
  };
}

function specApprovalInput(toolUseId: string): RequestPermissionRequestParams {
  return {
    toolUses: [
      {
        toolUse: {
          type: 'tool_use',
          id: toolUseId,
          name: 'ExitSpecMode',
          input: { [SENTINEL]: SENTINEL },
        },
        confirmationType: ToolConfirmationType.ExitSpecMode,
        details: {
          type: ToolConfirmationType.ExitSpecMode,
          plan: 'Run the reviewed plan.',
        },
      },
    ],
    options: [],
  };
}

function createHarness(
  options: { rejectProviderUpdate?: boolean; throwSummaryUpdate?: boolean } = {},
) {
  const emitted: ServerEvent[] = [];
  const errors: Array<Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>> = [];
  const trace: string[] = [];
  const liveSessions = new Map<string, DroidInteractionLiveSession>();
  const sink = new SessionInteractions({
    emit: (event) => {
      emitted.push(event);
    },
    emitError: (error) => {
      errors.push(error);
    },
  });
  const addLiveSession = (appSessionId: string) => {
    const liveSession: DroidInteractionLiveSession = {
      summary: summary(appSessionId),
      runtimeGeneration: 1,
      session: {
        updateSettings: (settings: Partial<UpdateSessionSettingsRequestParams>) => {
          trace.push(`provider:${String(settings.interactionMode ?? '')}`);
          return options.rejectProviderUpdate
            ? Promise.reject(new Error('provider rejected'))
            : Promise.resolve({});
        },
      },
    };
    liveSessions.set(appSessionId, liveSession);
    return liveSession;
  };
  const droid = new DroidInteractions({
    sink,
    getLiveSession: (id) => liveSessions.get(id),
    updateSummary: (id, patch) => {
      const liveSession = liveSessions.get(id);
      if (!liveSession) return;
      trace.push(`publish:${String(patch.configuration?.interactionMode ?? patch.phase ?? '')}`);
      if (options.throwSummaryUpdate) throw new Error('summary persistence failed');
      Object.assign(liveSession.summary, patch);
    },
    emitError: (error) => {
      trace.push(`error:${error.code ?? ''}`);
      errors.push(error);
    },
  });
  return { addLiveSession, droid, emitted, errors, liveSessions, sink, trace };
}

function latestApproval(events: ServerEvent[]) {
  const event = events.findLast(
    (entry): entry is Extract<ServerEvent, { type: 'approval.requested' }> =>
      entry.type === 'approval.requested',
  );
  assert.ok(event);
  return event.request;
}

function latestQuestion(events: ServerEvent[]) {
  const event = events.findLast(
    (entry): entry is Extract<ServerEvent, { type: 'question.requested' }> =>
      entry.type === 'question.requested',
  );
  assert.ok(event);
  return event.question;
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

const OUTCOME_TO_FACTORY: Record<(typeof PERMISSION_OUTCOMES)[number], ToolConfirmationOutcome> = {
  proceed_once: ToolConfirmationOutcome.ProceedOnce,
  proceed_always: ToolConfirmationOutcome.ProceedAlways,
  proceed_auto_run: ToolConfirmationOutcome.ProceedAutoRun,
  proceed_auto_run_low: ToolConfirmationOutcome.ProceedAutoRunLow,
  proceed_auto_run_medium: ToolConfirmationOutcome.ProceedAutoRunMedium,
  proceed_auto_run_high: ToolConfirmationOutcome.ProceedAutoRunHigh,
  proceed_new_session: ToolConfirmationOutcome.ProceedNewSession,
  proceed_new_session_low: ToolConfirmationOutcome.ProceedNewSessionLow,
  proceed_new_session_medium: ToolConfirmationOutcome.ProceedNewSessionMedium,
  proceed_new_session_high: ToolConfirmationOutcome.ProceedNewSessionHigh,
  proceed_edit: ToolConfirmationOutcome.ProceedEdit,
  cancel: ToolConfirmationOutcome.Cancel,
};

test('every Droid permission outcome maps to the Factory confirmation', async () => {
  for (const outcome of PERMISSION_OUTCOMES) {
    const harness = createHarness();
    harness.addLiveSession('app-1');
    const pending = harness.droid.makePermissionHandler({ id: 'app-1' })(permissionInput(outcome));
    const requestId = latestApproval(harness.emitted).requestId;
    harness.sink.respondToApproval('app-1', requestId, outcome);
    await harness.droid.drain();
    assert.equal(await pending, OUTCOME_TO_FACTORY[outcome], outcome);
  }
});

test('ProceedAlways bypasses only an equivalent later permission signature', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const handler = harness.droid.makePermissionHandler({ id: 'app-1' });
  const first = handler(permissionInput('tool-1', 'pwd'));
  await harness.sink.respondToApproval(
    'app-1',
    latestApproval(harness.emitted).requestId,
    'proceed_always',
  );
  await harness.droid.drain();
  assert.equal(await first, ToolConfirmationOutcome.ProceedAlways);
  assert.equal(
    await handler(permissionInput('tool-2', 'pwd')),
    ToolConfirmationOutcome.ProceedAlways,
  );
  assert.equal(harness.emitted.filter((event) => event.type === 'approval.requested').length, 1);

  const different = handler(permissionInput('tool-3', 'ls'));
  assert.equal(harness.emitted.filter((event) => event.type === 'approval.requested').length, 2);
  harness.sink.respondToApproval('app-1', latestApproval(harness.emitted).requestId, 'cancel');
  await harness.droid.drain();
  assert.equal(await different, ToolConfirmationOutcome.Cancel);
});

test('Spec approval publishes, attempts provider update, then settles the callback', async () => {
  const success = createHarness();
  const liveSession = success.addLiveSession('app-spec');
  liveSession.summary.configuration = {
    ...liveSession.summary.configuration,
    interactionMode: 'spec',
  };
  const pending = Promise.resolve(
    success.droid.makePermissionHandler({ id: 'app-spec' })(specApprovalInput('tool-spec')),
  ).then((outcome) => {
    success.trace.push('callback');
    return outcome;
  });
  success.sink.respondToApproval(
    'app-spec',
    latestApproval(success.emitted).requestId,
    'proceed_once',
  );
  await success.droid.drain();
  assert.equal(await pending, ToolConfirmationOutcome.ProceedOnce);
  assert.deepEqual(success.trace, ['publish:auto', 'provider:auto', 'callback']);
  assert.equal(liveSession.summary.phase, 'running');

  const rejected = createHarness({ rejectProviderUpdate: true });
  rejected.addLiveSession('app-spec');
  const rejectedPending = Promise.resolve(
    rejected.droid.makePermissionHandler({ id: 'app-spec' })(specApprovalInput('tool-spec')),
  ).then((outcome) => {
    rejected.trace.push('callback');
    return outcome;
  });
  rejected.sink.respondToApproval(
    'app-spec',
    latestApproval(rejected.emitted).requestId,
    'proceed_once',
  );
  await rejected.droid.drain();
  assert.equal(await rejectedPending, ToolConfirmationOutcome.ProceedOnce);
  assert.deepEqual(rejected.trace, [
    'publish:auto',
    'provider:auto',
    'error:spec.exit_failed',
    'callback',
  ]);
});

test('ask-user preserves exact keys and reconstructs native answers', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const pending = harness.droid.makeAskUserHandler({ id: 'app-1' })({
    toolCallId: 'question-tool',
    questions: [
      { index: 7, topic: 'input', question: 'What should change?', options: ['Title', 'Body'] },
    ],
  } as AskUserRequestParams);
  const request = latestQuestion(harness.emitted);
  assert.deepEqual(request.questions, [
    { id: '7', prompt: 'What should change?', options: ['Title', 'Body'], multiSelect: false },
  ]);
  harness.sink.respondToQuestion('app-1', request.requestId, false, { '7': ['The title'] });
  await harness.droid.drain();
  assert.deepEqual(await pending, {
    cancelled: false,
    answers: [{ index: 7, question: 'What should change?', answer: 'The title' }],
  });
});

test('empty ask-user requests cancel with no native answers', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const pending = harness.droid.makeAskUserHandler({ id: 'app-1' })({
    toolCallId: 'empty',
  } as AskUserRequestParams);
  assert.deepEqual(latestQuestion(harness.emitted).questions, []);
  harness.sink.respondToQuestion('app-1', latestQuestion(harness.emitted).requestId, true, {});
  await harness.droid.drain();
  assert.deepEqual(await pending, { cancelled: true, answers: [] });
});

test('createDroidNativeHandlers routes spec to plan review', async () => {
  const emitted: ServerEvent[] = [];
  const sink = new SessionInteractions({
    emit: (event) => {
      emitted.push(event);
    },
    emitError: () => undefined,
  });
  const handlers = createDroidNativeHandlers({
    runtimeGeneration: 4,
    runNativeCallback: async <T>(work: () => Promise<T>): Promise<T> => work(),
    createInput: {
      target: { kind: 'session', appSessionId: 'app-1' },
      ids: { nextEventId: () => 'native-spec' },
      interactionSink: sink,
    },
  });
  const pending = handlers.permissionHandler(specApprovalInput('spec-1'));
  const plan = emitted.find(
    (event): event is Extract<ServerEvent, { type: 'plan_review.requested' }> =>
      event.type === 'plan_review.requested',
  );
  assert.ok(plan);
  assert.equal(plan.request.plan, 'Run the reviewed plan.');
  sink.respondToPlanReview('app-1', plan.request.requestId, { decision: 'implement' });
  assert.equal(await pending, ToolConfirmationOutcome.ProceedOnce);
});

test('classified Droid permissions omit a sentinel native payload from the bridge event', async () => {
  const harness = createHarness();
  harness.addLiveSession('app-1');
  const pending = harness.droid.makePermissionHandler({ id: 'app-1' })(permissionInput('secret'));
  const event = harness.emitted.find(
    (entry): entry is Extract<ServerEvent, { type: 'approval.requested' }> =>
      entry.type === 'approval.requested',
  );
  assert.ok(event);
  const serialized = JSON.parse(JSON.stringify(event)) as unknown;
  const walked = collectedStrings(serialized);
  assert.equal(
    walked.some((value) => value.includes(SENTINEL)),
    false,
  );
  assert.equal(JSON.stringify(event).includes(SENTINEL), false);
  assert.equal('raw' in event.request, false);
  harness.sink.respondToApproval('app-1', event.request.requestId, 'cancel');
  await harness.droid.drain();
  await pending;
});

test('propose_mission updates the session phase before emitting the approval', async () => {
  const harness = createHarness();
  const live = harness.addLiveSession('app-1');
  const pending = harness.droid.makePermissionHandler({ id: 'app-1' })({
    toolUses: [
      {
        toolUse: { type: 'tool_use', id: 'm1', name: 'ProposeMission', input: {} },
        confirmationType: 'propose_mission' as never,
        details: {
          type: 'propose_mission',
          proposal: 'Do the work.',
          title: 'Mission plan proposed',
        },
      },
    ],
    options: [],
  } as RequestPermissionRequestParams);
  assert.equal(live.summary.phase, 'awaiting_plan_approval');
  harness.sink.respondToApproval('app-1', latestApproval(harness.emitted).requestId, 'cancel');
  await harness.droid.drain();
  assert.equal(await pending, ToolConfirmationOutcome.Cancel);
});

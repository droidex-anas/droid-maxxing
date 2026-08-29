import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from './protocol.js';
import {
  assistantTextDelta,
  FakeFactorySession,
  successfulResultEvent,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

function appendedTexts(events: ServerEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type === 'event.appended' && event.event.text) texts.push(event.event.text);
  }
  return texts;
}

function designToolPolicies(session: FakeFactorySession): unknown[] {
  return session.settings
    .filter((settings) => settings['disabledToolIds'] !== undefined)
    .map((settings) => settings['disabledToolIds']);
}

function latestSessionUpdate(events: ServerEvent[]) {
  return events
    .filter(
      (event): event is Extract<ServerEvent, { type: 'session.updated' }> =>
        event.type === 'session.updated',
    )
    .at(-1);
}

function isRecordedTranscript(call: RecordedCall, text: string): boolean {
  return (
    call.target === 'store' &&
    call.method === 'append' &&
    JSON.stringify(call.args[0] ?? {}).includes(text)
  );
}

function isAppendedTranscript(call: RecordedCall, text: string): boolean {
  const event = call.args[0];
  if (
    call.target !== 'protocol' ||
    call.method !== 'event' ||
    typeof event !== 'object' ||
    event === null ||
    !('type' in event) ||
    event.type !== 'event.appended' ||
    !('event' in event) ||
    typeof event.event !== 'object' ||
    event.event === null
  )
    return false;
  return 'text' in event.event && event.event.text === text;
}

function skillActivationNotification(detail: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: {
      notification: {
        type: 'create_message',
        message: {
          id: detail,
          role: 'user',
          visibility: 'user_only',
          content: [{ type: 'text', text: `Skill "early" activated: ${detail}` }],
        },
      },
    },
  };
}

class EarlyNativeNotificationSession extends FakeFactorySession {
  override async updateSettings(
    settings: Parameters<FakeFactorySession['updateSettings']>[0],
  ): ReturnType<FakeFactorySession['updateSettings']> {
    if (this.notifications.size === 0) {
      this.emitNotification(skillActivationNotification('before DROIDEX subscribed'));
    }
    return super.updateSettings(settings);
  }

  override onNotification(
    ...args: Parameters<FakeFactorySession['onNotification']>
  ): ReturnType<FakeFactorySession['onNotification']> {
    const unsubscribe = super.onNotification(...args);
    this.emitNotification(skillActivationNotification('as soon as DROIDEX subscribed'));
    return unsubscribe;
  }
}

test('design turns synchronize TodoWrite and unexpected AbortErrors fail the turn', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-design',
      title: 'Event design',
      goal: 'initial normal prompt',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();

    const designPrompt =
      'Design Mode reference pack:\n- URL: about:blank\n\nUser instruction:\nMake the hero cleaner';
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: designPrompt,
    });
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'restore normal tools',
    });
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'normal tools stay restored',
    });

    assert.deepEqual(designToolPolicies(provider), [[], ['TodoWrite'], []]);

    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    provider.nextStreamError = abort;
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'unexpected abort',
    });

    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'error' &&
          event.appSessionId === 'provider-1' &&
          event.message === abort.message,
      ),
      true,
    );
    assert.equal(
      context.events.some(
        (event) => event.type === 'session.updated' && event.session.phase === 'failed',
      ),
      true,
    );
  } finally {
    await context.dispose();
  }
});

test('a buffered streaming tail is emitted before failed turn settlement', async () => {
  const context = createSessionManagerTestContext({ streamingCoalesceMs: 1_000 });
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-failed-tail',
      title: 'Failed tail',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    context.events.length = 0;

    provider.queueStreamEvents([assistantTextDelta('buffered before failure')]);
    provider.nextStreamError = new Error('provider failed');
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'fail after a partial response',
    });
    await context.waitForIdle();

    const appendedIndex = context.events.findIndex(
      (event) => event.type === 'event.appended' && event.event.text === 'buffered before failure',
    );
    const errorIndex = context.events.findIndex(
      (event) => event.type === 'error' && event.message === 'provider failed',
    );
    const failedIndex = context.events.findIndex(
      (event) => event.type === 'session.updated' && event.session.phase === 'failed',
    );
    assert.ok(appendedIndex >= 0);
    assert.ok(errorIndex > appendedIndex);
    assert.ok(failedIndex > errorIndex);
  } finally {
    await context.dispose();
  }
});

test('primary streaming persistence failures still settle and refresh context', async () => {
  const context = createSessionManagerTestContext({ streamingCoalesceMs: 1_000 });
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-persist-failure',
      title: 'Persist failure',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    const contextStatsCallsBeforeTurn = provider.contextStatsCalls;
    context.events.length = 0;

    provider.queueStreamEvents([assistantTextDelta('cannot persist this tail')]);
    context.history.recordEventErrorForText = {
      text: 'cannot persist this tail',
      error: new Error('history write failed'),
    };
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'trigger a streaming persistence failure',
    });
    await context.waitForIdle();

    assert.equal(
      context.events.filter(
        (event) =>
          event.type === 'error' &&
          event.message === 'Could not persist streaming transcript: history write failed',
      ).length,
      1,
    );
    assert.equal(latestSessionUpdate(context.events)?.session.phase, 'failed');
    assert.ok(provider.contextStatsCalls >= contextStatsCallsBeforeTurn + 2);
    assert.equal(appendedTexts(context.events).includes('cannot persist this tail'), false);
  } finally {
    await context.dispose();
  }
});

test('terminal results quarantine only later generation from the same turn', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-terminal',
      title: 'Event terminal',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    context.history.seedSessionLaunchSettings('worker-1', { modelId: 'model-default' });
    context.events.length = 0;
    provider.queueStreamEvents([
      assistantTextDelta('final answer'),
      successfulResultEvent('provider-1'),
      assistantTextDelta('leaked tail'),
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'task-1',
          name: 'Task',
          input: { subagent_type: 'worker' },
        },
      },
      {
        type: 'tool_progress',
        toolUseId: 'task-1',
        toolName: 'Task',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-1',
          parameters: { subagent_type: 'worker' },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Execute',
        toolUseId: 'execute-1',
        content: 'boom',
        isError: true,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'terminal turn',
    });

    const recordIndex = context.calls.findIndex((call) =>
      isRecordedTranscript(call, 'final answer'),
    );
    const emitIndex = context.calls.findIndex((call) => isAppendedTranscript(call, 'final answer'));
    assert.ok(recordIndex >= 0);
    assert.ok(emitIndex > recordIndex);
    assert.deepEqual(appendedTexts(context.events), ['final answer', 'boom']);
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'session.child' &&
          event.child.status === 'running' &&
          event.child.childSessionId === 'child-1',
      ),
      true,
    );
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.kind === 'tool_call' &&
          event.event.toolName === 'Task',
      ),
      false,
    );

    provider.queueStreamEvents([assistantTextDelta('next turn answer')]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'next turn',
    });
    assert.equal(appendedTexts(context.events).includes('next turn answer'), true);
  } finally {
    await context.dispose();
  }
});

test('terminal enforcement is scoped to each provider and includes notification events', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'mission-control',
      clientRef: 'event-worker',
      title: 'Event worker',
      goal: 'primary becomes terminal',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    });
    await context.provider.waitForPrompts('provider-1', 1);
    await context.waitForIdle();
    context.history.seedSessionLaunchSettings('worker-logical', {
      modelId: 'model-default',
    });
    const primary = context.provider.session('provider-1');
    primary.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'task-1',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-logical',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });
    const worker = new FakeFactorySession('worker-backend', {}, context.calls);
    context.runtime.loadQueue.set('worker-logical', [worker]);
    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-1',
    });

    context.provider.emitNotification('worker-backend', {
      type: 'assistant_text_delta',
      messageId: 'worker-message-1',
      blockIndex: 0,
      textDelta: 'worker notification before terminal',
    });
    assert.equal(
      appendedTexts(context.events).includes('worker notification before terminal'),
      true,
    );
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.text === 'worker notification before terminal' &&
          event.event.appSessionId === 'provider-1' &&
          event.event.sourceSessionId === 'child-1',
      ),
      true,
    );

    worker.queueStreamEvents([assistantTextDelta('worker still talking')]);
    await context.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      text: 'worker turn',
    });
    assert.equal(appendedTexts(context.events).includes('worker still talking'), true);
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.text === 'worker still talking' &&
          event.event.sourceSessionId === 'child-1',
      ),
      true,
    );

    context.provider.emitNotification('worker-backend', {
      type: 'assistant_text_delta',
      messageId: 'worker-message-2',
      blockIndex: 0,
      textDelta: 'late worker tail',
    });
    assert.equal(appendedTexts(context.events).includes('late worker tail'), false);
  } finally {
    await context.dispose();
  }
});

test('current SDK Task result persists and opens the exact completed child', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-task-result-child',
      title: 'Task result child',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    context.history.seedSessionLaunchSettings('provider-child-current', {
      modelId: 'model-default',
    });
    context.events.length = 0;
    provider.queueStreamEvents([
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'task-current',
          name: 'Task',
          input: {
            subagent_type: 'worker',
            description: 'Smoke test reply',
            prompt: 'Reply exactly CHILD_SMOKE_OK and stop.',
          },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Task',
        toolUseId: 'task-current',
        content: 'session_id: provider-child-current\nCHILD_SMOKE_OK',
        isError: false,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });

    const child = context.fixture.childRecords('provider-1')[0];
    assert.equal(child?.parentAppSessionId, 'provider-1');
    assert.equal(child?.childSessionId, 'child-1');
    assert.equal(child?.providerSessionId, 'provider-child-current');
    assert.equal(child?.status, 'completed');
    assert.equal(child?.transcriptAvailable, true);
    assert.deepEqual(child?.spawnLink, { kind: 'tool-use', id: 'task-current' });

    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-current-child',
    });
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.access === 'history' &&
          event.parentAppSessionId === 'provider-1' &&
          event.childSessionId === 'child-1' &&
          event.requestId === 'open-current-child',
      ),
      true,
    );
  } finally {
    await context.dispose();
  }
});

test('background Task completion notification settles a child without TaskOutput', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-background-task-completion',
      title: 'Background task completion',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    context.events.length = 0;
    context.history.seedSessionLaunchSettings('provider-child-background', {
      modelId: 'custom:glm-5.2',
      reasoningEffort: 'max',
    });

    provider.queueStreamEvents([
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'task-background',
          name: 'Task',
          input: { subagent_type: 'worker-2', description: 'background work' },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Task',
        toolUseId: 'task-background',
        content:
          'Task launched in background.\ntask_id: provider-child-background\nsession_id: provider-child-background',
        isError: false,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'launch background worker',
    });

    const launched = context.fixture.childRecords('provider-1')[0];
    assert.equal(launched?.status, 'running');
    assert.equal(launched?.label, 'worker-2');
    assert.equal(launched?.modelId, 'custom:glm-5.2');
    assert.equal(launched?.reasoningEffort, 'max');

    context.provider.emitNotification('provider-1', {
      jsonrpc: '2.0',
      method: 'droid.session_notification',
      params: {
        notification: {
          type: 'create_message',
          message: {
            id: 'background-completion-message',
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Background task completed.\ntask_id: provider-child-background\noutput: done',
              },
            ],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      },
    });

    assert.equal(context.fixture.childRecords('provider-1')[0]?.status, 'completed');
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'session.child' &&
          event.child.childSessionId === 'child-1' &&
          event.child.status === 'completed',
      ),
      true,
    );
  } finally {
    await context.dispose();
  }
});

test('worker token usage updates totals without replacing the primary context reading', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'mission-control',
      clientRef: 'event-tokens',
      title: 'Event tokens',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    });
    await context.provider.waitForPrompts('provider-1', 1);
    await context.waitForIdle();

    context.provider.session('provider-1').queueStreamEvents([
      {
        type: 'token_usage_update',
        inputTokens: 5,
        outputTokens: 2,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
        thinkingTokens: 0,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'primary usage',
    });
    assert.equal(latestSessionUpdate(context.events)?.session.contextTokens, 9);
    assert.equal(latestSessionUpdate(context.events)?.session.contextAccuracy, 'exact');

    context.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'child-tokens',
        providerSessionId: 'worker-tokens',
        role: 'worker',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-tokens',
      requestId: 'open-child-tokens',
    });
    context.provider.session('worker-tokens').queueStreamEvents([
      {
        type: 'token_usage_update',
        inputTokens: 50,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
    ]);
    await context.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-tokens',
      text: 'worker usage',
    });

    const summary = latestSessionUpdate(context.events)?.session;
    assert.equal(summary?.tokensIn, 50);
    assert.equal(summary?.tokensOut, 20);
    assert.equal(summary?.contextTokens, 9);
    assert.equal(summary?.contextAccuracy, 'exact');
  } finally {
    await context.dispose();
  }
});

test('loaded child context follows its parent-scoped logical identity', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'mission-control',
      clientRef: 'event-child-context',
      title: 'Child context',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    });
    await context.provider.waitForPrompts('provider-1', 1);
    await context.waitForIdle();
    context.history.seedSessionLaunchSettings('worker-history-id', {
      modelId: 'model-default',
    });

    const primary = context.provider.session('provider-1');
    primary.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'task-context',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-history-id',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });
    context.runtime.loadQueue.set('worker-history-id', [
      new FakeFactorySession('worker-runtime-id', {}, context.calls),
    ]);
    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-history',
    });
    const compactionNotification = (notification: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      method: 'droid.session_notification',
      params: { notification },
    });
    context.provider.emitNotification(
      'worker-runtime-id',
      compactionNotification({
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      }),
    );
    context.provider.emitNotification(
      'worker-runtime-id',
      compactionNotification({
        type: 'session_compacted',
        summaryId: 'summary-context',
        removedCount: 1,
        visibleBoundaryMessageId: null,
      }),
    );
    await context.waitForIdle();
    context.events.length = 0;

    await context.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      text: 'measure context',
    });

    const runtimeContext = context.events.find(
      (event) =>
        event.type === 'context.updated' &&
        event.appSessionId === 'provider-1' &&
        event.sourceSessionId === 'child-1' &&
        event.parentAppSessionId === 'provider-1' &&
        event.childSessionId === 'child-1',
    );
    assert.equal(runtimeContext?.type, 'context.updated');
    assert.equal(runtimeContext.stats.compactions, 1);
  } finally {
    await context.dispose();
  }
});

test('a native notification that arrives before the session is published is dropped', async () => {
  const context = createSessionManagerTestContext();
  const provider = new EarlyNativeNotificationSession('provider-early', {}, context.calls);
  const streamGate = provider.deferNextStream();
  context.runtime.createQueue.push(provider);

  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'early-note',
      title: 'Early note',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });

    // Surprise: subscribePrimary attaches onNotification before register, but
    // isCurrent requires the live registry entry, so both the pre-subscribe
    // note and the subscribe-time note are dropped. There is no pre-activation
    // buffer. TODO: provider seam must preserve this drop or flush a buffer.
    assert.equal(
      appendedTexts(context.events).some((text) => text.includes('before DROIDEX subscribed')),
      false,
    );
    assert.equal(
      appendedTexts(context.events).some((text) => text.includes('as soon as DROIDEX subscribed')),
      false,
    );
    assert.ok(context.events.some((event) => event.type === 'session.created'));

    context.provider.emitNotification(
      'provider-early',
      skillActivationNotification('after the session is published'),
    );
    assert.equal(
      appendedTexts(context.events).includes(
        'Skill "early" activated: after the session is published',
      ),
      true,
    );
  } finally {
    streamGate.resolve();
    await context.dispose();
  }
});

test('a transcript event is recorded to history before it is broadcast', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'record-before-emit',
      title: 'Record before emit',
      goal: 'initial',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();

    provider.queueStreamEvents([assistantTextDelta('durable before broadcast')]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'speak',
    });

    const recordIndex = context.calls.findIndex((call) =>
      isRecordedTranscript(call, 'durable before broadcast'),
    );
    const emitIndex = context.calls.findIndex((call) =>
      isAppendedTranscript(call, 'durable before broadcast'),
    );
    assert.ok(recordIndex >= 0);
    assert.ok(emitIndex > recordIndex);
  } finally {
    await context.dispose();
  }
});

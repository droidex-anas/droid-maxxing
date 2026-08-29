import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DecompSessionType } from '@factory/droid-sdk';

import type { SessionSummary } from './protocol.js';
import { writeProviderConversation } from './testing/historyCharacterizationSupport.js';
import { assistantTextDelta, FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import { TranscriptStore } from './persistence/TranscriptStore.js';

class DeferredDesignPolicySession extends FakeFactorySession {
  private rejectDesignPolicyUpdate?: (error: Error) => void;

  override updateSettings(
    settings: Parameters<FakeFactorySession['updateSettings']>[0],
  ): ReturnType<FakeFactorySession['updateSettings']> {
    if (!('disabledToolIds' in settings)) return super.updateSettings(settings);
    return new Promise((_, reject) => {
      this.rejectDesignPolicyUpdate = reject;
    });
  }

  rejectDesignPolicy(error: Error): void {
    assert.ok(this.rejectDesignPolicyUpdate);
    this.rejectDesignPolicyUpdate(error);
  }
}

test('[L1] Ordinary create', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l1',
      title: 'ordinary',
      goal: 'hello',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });

    const options = h.runtime.createCalls[0];
    assert.ok(options);
    assert.equal(options.interactionMode, 'auto');
    assert.equal(options.autonomyLevel, 'low');
    assert.deepEqual(
      options.mcpServers?.map((server) => server.name),
      ['test-cli', 'test-browser'],
      'the effective CLI MCP config and DROIDEX browser MCP must initialize together',
    );
    assert.equal(
      h.calls.some((call) => call.target === 'provider' && call.method === 'addMcpServer'),
      false,
      'DROIDEX-owned runtime servers must never be persisted into Droid user config',
    );
    assert.equal(
      h.events.find((event) => event.type === 'session.created')?.session.sessionPurpose,
      'chat',
    );
    assert.deepEqual(h.provider.session('provider-1').prompts, ['hello']);
  } finally {
    await h.dispose();
  }
});

test('App response format enriches the provider prompt without changing the user request', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'app-format-create',
      title: 'App request',
      goal: '/visualize compare renderer timings',
      responseFormat: 'app-create',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });

    const createPrompt = h.provider.session('provider-1').prompts[0];
    assert.match(createPrompt, /^DROIDEX App request:/);
    assert.match(createPrompt, /\/visualize compare renderer timings/);
    assert.match(createPrompt, /fenced `app` block/);

    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: '/visualize turn this into a timeline',
      responseFormat: 'app-create',
    });
    await h.provider.waitForPrompts('provider-1', 2);

    const sendPrompt = h.provider.session('provider-1').prompts[1];
    assert.match(sendPrompt, /^DROIDEX App request:/);
    assert.match(sendPrompt, /\/visualize turn this into a timeline/);
  } finally {
    await h.dispose();
  }
});

test('unsupported App response formats fail before reaching the provider', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'invalid-app-format',
      title: 'App request',
      goal: 'hello',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });

    await assert.rejects(
      h.handle({
        type: 'session.send',
        appSessionId: 'provider-1',
        text: 'keep going',
        responseFormat: 'future-app-format',
      } as never),
      /Unsupported response format: future-app-format/,
    );
    assert.deepEqual(h.provider.session('provider-1').prompts, ['hello']);
  } finally {
    await h.dispose();
  }
});

test('[L2] Spec create', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l2',
      title: 'spec',
      goal: 'write',
      configuration: droidSessionConfiguration({
        modelId: 'spec-model',
        reasoningEffort: 'high',
        interactionMode: 'spec',
        autonomy: 'off',
      }),
    });

    const options = h.runtime.createCalls[0];
    assert.ok(options);
    assert.equal(options.interactionMode, 'spec');
    assert.equal(options.specModeModelId, 'spec-model');
    assert.equal(options.workerModelId, undefined);
    assert.equal(
      h.events.find((event) => event.type === 'session.created')?.session.configuration
        .interactionMode,
      'spec',
    );
  } finally {
    await h.dispose();
  }
});

test(
  'design purpose is independent from auto interaction mode',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'design',
        clientRef: 'design-purpose',
        title: 'design',
        goal: 'draw',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });

      const created = h.events.find((event) => event.type === 'session.created');
      assert.equal(created?.session.sessionPurpose, 'design');
      assert.equal(created?.session.configuration.interactionMode, 'auto');
      assert.equal(created?.session.missionId, undefined);
      assert.equal(h.runtime.createCalls[0]?.decompSessionType, undefined);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'AGI interaction mode does not imply Mission Control purpose',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'agi-chat',
        title: 'agi chat',
        goal: 'reason',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'agi',
          autonomy: 'low',
        }),
      });

      const created = h.events.find((event) => event.type === 'session.created');
      assert.equal(created?.session.sessionPurpose, 'chat');
      assert.equal(created?.session.configuration.interactionMode, 'agi');
      assert.equal(created?.session.missionId, undefined);
      assert.equal(h.runtime.createCalls[0]?.decompSessionType, undefined);
    } finally {
      await h.dispose();
    }
  },
);

test('[L3] AGI create', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'l3',
      title: 'agi',
      goal: 'plan',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
      droidMissionConfiguration: {
        worker: { modelId: 'worker' },
        validator: { modelId: 'validator' },
      },
    });

    const options = h.runtime.createCalls[0];
    assert.ok(options);
    assert.equal(options.decompSessionType, DecompSessionType.Orchestrator);
    assert.equal(options.workerModelId, 'worker');
    assert.equal(options.validatorModelId, 'validator');
    assert.equal(
      h.events.find((event) => event.type === 'session.created')?.session.sessionPurpose,
      'mission-control',
    );
  } finally {
    await h.dispose();
  }
});

test('[L4] Create failure cleanup', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  h.runtime.createQueue.push(new Error('create failed'));

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l4',
      title: 'failure',
      goal: 'fail',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });

    assert.equal(
      h.events.some((event) => event.type === 'session.created'),
      false,
    );
    assert.equal(
      h.calls.some((call) => call.target === 'history' && call.method === 'syncSummaries'),
      false,
    );
    assert.equal(
      h.events.some((event) => event.type === 'error' && event.message === 'create failed'),
      true,
    );
    assert.equal(h.mcpServerCloseCalls, 1);
  } finally {
    await h.dispose();
  }
});

test(
  '[L5] Resume preserves the app identity while loading the provider session',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([summary('app-5', 'provider-5')]);
      assert.equal(
        existsSync(path.join(h.home, '.factory', 'sessions', 'provider-5.jsonl')),
        false,
      );
      assert.equal(
        h.calls.some((call) => call.target === 'history' && call.method === 'syncSummaries'),
        false,
      );
      writeProviderConversation(h.home, 'provider-5', 'Historical app-5');
      h.runtime.loadQueue.set('provider-5', [new FakeFactorySession('provider-5', {}, h.calls)]);
      await h.handle({ type: 'session.resume', appSessionId: 'app-5' });

      assert.equal(h.runtime.loadCalls.length, 1);
      assert.equal(h.runtime.loadCalls[0]?.sessionId, 'provider-5');
      assert.equal(
        h.events.find((event) => event.type === 'session.created')?.session.appSessionId,
        'app-5',
      );
      assert.ok(h.runtime.loadCalls[0]?.handlers.permissionHandler);
      assert.ok(h.runtime.loadCalls[0]?.handlers.askUserHandler);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'resuming an AGI chat preserves its explicit non-Mission-Control purpose',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([
        {
          ...summary('app-agi-chat', 'provider-agi-chat'),
          configuration: droidSessionConfiguration({
            modelId: 'model-default',
            interactionMode: 'agi',
            autonomy: 'low',
          }),
        },
      ]);
      writeProviderConversation(h.home, 'provider-agi-chat', 'AGI chat');
      h.runtime.loadQueue.set('provider-agi-chat', [
        new FakeFactorySession('provider-agi-chat', {}, h.calls, {
          settings: { interactionMode: 'agi' },
          mission: { state: 'running', features: [] },
        }),
      ]);

      await h.handle({ type: 'session.resume', appSessionId: 'app-agi-chat' });

      const resumed = h.events.find((event) => event.type === 'session.created')?.session;
      assert.equal(resumed?.sessionPurpose, 'chat');
      assert.equal(resumed?.configuration.interactionMode, 'agi');
      assert.equal(resumed?.missionId, undefined);
      assert.deepEqual(resumed?.features, []);
      assert.equal(resumed?.phase, 'paused');
      assert.equal(
        h.events.some((event) => event.type === 'mission.features'),
        false,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[L6] Send lazily resumes a historical session', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-6', 'provider-6')]);
    assert.equal(existsSync(path.join(h.home, '.factory', 'sessions', 'provider-6.jsonl')), false);
    assert.equal(
      h.calls.some((call) => call.target === 'history' && call.method === 'syncSummaries'),
      false,
    );
    writeProviderConversation(h.home, 'provider-6', 'Historical app-6');
    h.runtime.loadQueue.set('provider-6', [new FakeFactorySession('provider-6', {}, h.calls)]);
    await h.handle({ type: 'session.send', appSessionId: 'app-6', text: 'once' });

    assert.equal(h.runtime.loadCalls.length, 1);
    assert.deepEqual(h.provider.session('provider-6').prompts, ['once']);
  } finally {
    await h.dispose();
  }
});

test(
  'mixed stable and provider identities preserve output across turns',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([summary('app-alias', 'provider-alias')]);
      writeProviderConversation(h.home, 'provider-alias', 'Alias');
      const provider = new FakeFactorySession('provider-alias', {}, h.calls);
      provider.queueStreamEvents([assistantTextDelta('first answer', 'first-message')]);
      provider.queueStreamEvents([assistantTextDelta('second answer', 'second-message')]);
      h.runtime.loadQueue.set('provider-alias', [provider]);

      await h.handle({ type: 'session.send', appSessionId: 'app-alias', text: 'first' });
      await h.handle({ type: 'session.send', appSessionId: 'provider-alias', text: 'second' });

      const textEvents = h.events.flatMap((event) =>
        event.type === 'event.appended' && event.event.kind === 'text' ? [event.event] : [],
      );
      assert.deepEqual(provider.prompts, ['first', 'second']);
      assert.deepEqual(
        textEvents.map((event) => event.text),
        ['first answer', 'second answer'],
      );
      assert.deepEqual(
        textEvents.map((event) => event.appSessionId),
        ['app-alias', 'app-alias'],
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'provider aliases apply pending settings before the first send',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    const providerSessionId = 'provider-pending-alias';

    try {
      h.fixture.seedHistorySummaries([
        {
          ...summary('app-pending-alias', providerSessionId),
          configuration: droidSessionConfiguration({
            modelId: 'model-old',
            interactionMode: 'auto',
            autonomy: 'low',
          }),
        },
      ]);
      writeProviderConversation(h.home, providerSessionId, 'Pending alias');
      await h.handle({
        type: 'settings.agent.update',
        appSessionId: providerSessionId,
        agent: 'primary',
        modelId: 'model-default',
      });
      const provider = new FakeFactorySession(providerSessionId, {}, h.calls, {
        settings: { modelId: 'model-old' },
      });
      h.runtime.loadQueue.set(providerSessionId, [provider]);

      await h.handle({
        type: 'session.send',
        appSessionId: providerSessionId,
        text: 'apply pending model',
      });

      const modelUpdateIndex = h.calls.findIndex((call) => {
        const settings = call.args[1];
        return (
          call.method === 'updateSettings' &&
          typeof settings === 'object' &&
          settings !== null &&
          'modelId' in settings &&
          settings.modelId === 'model-default'
        );
      });
      const streamIndex = h.calls.findIndex(
        (call) => call.method === 'stream' && call.args[1] === 'apply pending model',
      );
      assert.ok(modelUpdateIndex >= 0 && modelUpdateIndex < streamIndex);
      assert.deepEqual(provider.prompts, ['apply pending model']);
    } finally {
      await h.dispose();
    }
  },
);

test('[L7] Send-now steers ahead of queued sends', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  const gate = h.runtime.deferNextCreateStream('provider-1');

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l7',
      title: 'L7',
      goal: 'first',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'second' });
    await h.handle({ type: 'session.sendNow', appSessionId: 'provider-1', text: 'steer' });

    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 1);
    gate.resolve();
    await h.provider.waitForPrompts('provider-1', 3);

    assert.deepEqual(h.provider.session('provider-1').prompts, ['first', 'steer', 'second']);
  } finally {
    await h.dispose();
  }
});

test('closing an active turn suppresses later provider errors and context refresh', async () => {
  const h = createSessionManagerTestContext();
  const gate = h.runtime.deferNextCreateStream('provider-close');

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'close-active',
      title: 'Close active',
      goal: 'wait',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    await h.provider.waitForPrompts('provider-close', 1);
    h.provider.session('provider-close').nextStreamError = new Error('transport closed');

    await h.handle({ type: 'session.close', appSessionId: 'provider-close' });
    const eventsAfterClose = h.events.length;
    gate.resolve();
    await h.waitForIdle();
    await h.waitForIdle();

    assert.deepEqual(h.events.slice(eventsAfterClose), []);
  } finally {
    await h.dispose();
  }
});

test('closing suppresses in-flight policy and context updates', async () => {
  const h = createSessionManagerTestContext();
  const provider = new DeferredDesignPolicySession('provider-late-effects', {}, h.calls);
  const streamGate = provider.deferNextStream();
  const contextGate = provider.deferNextContextStats();
  h.runtime.createQueue.push(provider);

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'close-late-effects',
      title: 'Close late effects',
      goal: 'wait',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });

    await h.handle({ type: 'session.close', appSessionId: 'provider-late-effects' });
    const eventsAfterClose = h.events.length;
    provider.rejectDesignPolicy(new Error('policy transport closed'));
    contextGate.resolve();
    streamGate.resolve();
    await h.waitForIdle();
    await h.waitForIdle();

    assert.deepEqual(h.events.slice(eventsAfterClose), []);
  } finally {
    await h.dispose();
  }
});

test('[L8] Stop state matrix', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l8',
      title: 'L8',
      goal: 'idle',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    await h.waitForIdle();
    await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'after idle stop' });
    assert.deepEqual(h.provider.session('provider-1').prompts, ['idle', 'after idle stop']);

    const streamGate = h.provider.deferNextStream('provider-1');
    const sending = h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'stream' });
    await h.provider.waitForPrompts('provider-1', 3);
    await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 2);
    streamGate.resolve();
    await sending;
    await h.waitForIdle();

    const compactGate = h.provider.deferNextCompaction('provider-1');
    const compacting = h.handle({ type: 'session.compact', appSessionId: 'provider-1' });
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'drop while compacting',
    });
    await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 2);
    compactGate.resolve();
    await compacting;
    assert.deepEqual(h.provider.session('provider-1').prompts, [
      'idle',
      'after idle stop',
      'stream',
    ]);
  } finally {
    await h.dispose();
  }
});

test(
  '[L9] Interaction-mode mutation reports provider rejection',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'l9',
        title: 'L9',
        goal: 'go',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });
      await h.waitForIdle();
      const specCallsAfterCreate = h.calls.filter((call) => call.method === 'enterSpecMode').length;
      await h.handle({
        type: 'session.updateSettings',
        appSessionId: 'provider-1',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'spec',
          autonomy: 'low',
        }),
      });
      assert.equal(
        h.calls.filter((call) => call.method === 'enterSpecMode').length,
        specCallsAfterCreate,
      );
      assert.equal(
        h.events.filter((event) => event.type === 'session.updated').pop()?.session.configuration
          .interactionMode,
        'spec',
      );
      assert.equal(
        h.events.filter((event) => event.type === 'session.updated').pop()?.session.configuration
          .autonomy,
        'low',
      );

      h.provider.session('provider-1').nextEnterSpecModeError = new Error('mode rejected');
      await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'next' });
      await h.waitForIdle();

      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.message === 'Could not apply session configuration: mode rejected',
        ),
        true,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[L10] Autonomy mutation reports provider rejection', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l10',
      title: 'L10',
      goal: 'go',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'off',
      }),
    });
    await h.waitForIdle();
    const nativeWritesAfterCreate = h.provider.session('provider-1').settings.length;
    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    assert.equal(h.provider.session('provider-1').settings.length, nativeWritesAfterCreate);
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').pop()?.session.configuration
        .autonomy,
      'low',
    );

    h.provider.session('provider-1').nextUpdateSettingsError = new Error('autonomy rejected');
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'next' });
    await h.waitForIdle();

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.message === 'Could not apply session configuration: autonomy rejected',
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test(
  'create, resume, send, interrupt, and close publish in that user-visible order',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    const createGate = h.runtime.deferNextCreateStream('provider-1');

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'lifecycle-order',
        title: 'Order',
        goal: 'first',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });

      const created = h.events.find((event) => event.type === 'session.created');
      const createdIndex = h.events.findIndex((event) => event.type === 'session.created');
      const streamingIndex = h.events.findIndex(
        (event) => event.type === 'session.updated' && event.session.streaming,
      );
      assert.equal(created?.clientRef, 'lifecycle-order');
      assert.equal(created?.session.appSessionId, 'provider-1');
      assert.ok(streamingIndex > createdIndex);
      assert.equal(
        h.events.some((event) => event.type === 'session.closed'),
        false,
      );

      createGate.resolve();
      await h.provider.waitForPrompts('provider-1', 1);
      await h.waitForIdle();

      await h.handle({ type: 'session.resume', appSessionId: 'provider-1' });
      const resumed = h.events.filter((event) => event.type === 'session.created').at(-1);
      assert.equal(resumed?.clientRef, 'resume:provider-1');
      assert.equal(resumed?.session.appSessionId, 'provider-1');
      assert.equal(h.runtime.loadCalls.length, 0);

      const sendGate = h.provider.deferNextStream('provider-1');
      const sending = h.handle({
        type: 'session.send',
        appSessionId: 'provider-1',
        text: 'second',
      });
      await h.provider.waitForPrompts('provider-1', 2);
      await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
      assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 1);
      sendGate.resolve();
      await sending;
      await h.waitForIdle();

      await h.handle({ type: 'session.close', appSessionId: 'provider-1' });

      const resumeIndex = h.events.findIndex(
        (event) => event.type === 'session.created' && event.clientRef === 'resume:provider-1',
      );
      const pausedIndex = h.events.findIndex(
        (event) => event.type === 'session.updated' && event.session.phase === 'paused',
      );
      const closed = h.events.find((event) => event.type === 'session.closed');
      const closedIndex = h.events.findIndex((event) => event.type === 'session.closed');
      assert.ok(createdIndex < resumeIndex);
      assert.ok(resumeIndex < pausedIndex);
      assert.ok(pausedIndex < closedIndex);
      assert.equal(closed?.appSessionId, 'provider-1');
    } finally {
      createGate.resolve();
      await h.dispose();
    }
  },
);

test(
  'two creates with the same clientRef open two independent sessions',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'shared-ref',
        title: 'First',
        goal: 'one',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });
      await h.provider.waitForPrompts('provider-1', 1);
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'shared-ref',
        title: 'Second',
        goal: 'two',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });
      await h.provider.waitForPrompts('provider-2', 1);

      const created = h.events.filter((event) => event.type === 'session.created');
      // No-store characterization: durable clientRef replay is F7's store path.
      assert.equal(created.length, 2);
      assert.equal(created[0]?.clientRef, 'shared-ref');
      assert.equal(created[1]?.clientRef, 'shared-ref');
      assert.equal(created[0]?.session.appSessionId, 'provider-1');
      assert.equal(created[1]?.session.appSessionId, 'provider-2');
      assert.equal(created[0]?.session.title, 'First');
      assert.equal(created[1]?.session.title, 'Second');
      assert.equal(h.runtime.createCalls.length, 2);
      assert.deepEqual(h.provider.session('provider-1').prompts, ['one']);
      assert.deepEqual(h.provider.session('provider-2').prompts, ['two']);
      assert.equal(
        h.events.some((event) => event.type === 'error'),
        false,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('Summary patches preserve existing provider transcripts', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l11',
      title: 'L11',
      goal: 'go',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const file = path.join(h.home, '.factory', 'sessions', 'provider-1.jsonl');
    const transcript =
      `${JSON.stringify({
        type: 'session_start',
        sessionId: 'provider-1',
        sessionTitle: 'L11',
        cwd: '',
      })}\n` +
      `${JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'preserve me' }] },
      })}\n`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, transcript);

    await h.waitForIdle();
    const syncSummariesBefore = h.calls.filter(
      (call) => call.target === 'history' && call.method === 'syncSummaries',
    ).length;

    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'high',
      }),
    });

    assert.equal(
      h.calls.filter((call) => call.target === 'history' && call.method === 'syncSummaries').length,
      syncSummariesBefore + 1,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').at(-1)?.session.configuration
        .autonomy,
      'high',
    );
    assert.equal(
      h.history.summaryPatchesAndHidden().patches.get('provider-1')?.configuration?.autonomy,
      'high',
    );
    assert.equal(readFileSync(file, 'utf8'), transcript);
  } finally {
    await h.dispose();
  }
});

test(
  'History fixture materializes only persisted summary metadata',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    const seeded: SessionSummary = {
      ...summary('app-history', 'provider-old'),
      compactedFromProviderSessionIds: [
        'provider-older',
        'provider-oldest',
        'app-history',
        '',
        'provider-older',
      ],
      title: 'Persisted title',
      goal: 'transient goal',
      workspaceKind: 'folder',
      configuration: droidSessionConfiguration({
        modelId: 'primary-model',
        reasoningEffort: 'high',
        interactionMode: 'auto',
        autonomy: 'high',
      }),
      droidMissionConfiguration: {
        worker: { modelId: 'worker-model', reasoningEffort: 'medium' },
        validator: { modelId: 'validator-model', reasoningEffort: 'low' },
      },
      compactionModel: 'compaction-model',
      phase: 'running',
      streaming: true,
      queuedSends: 2,
      features: [],
      tokensIn: 11,
      tokensOut: 12,
      contextTokens: 13,
      contextRemainingTokens: 14,
      contextAccuracy: 'exact',
      contextUpdatedAt: '2026-07-27T00:00:00.000Z',
      maxContextTokens: 15,
      autoCompactions: 16,
      createdAt: 17,
      updatedAt: 18,
    };

    try {
      h.fixture.seedHistorySummaries([seeded]);
      h.fixture.seedHistorySummaries([
        { ...seeded, providerSessionId: 'provider-current', updatedAt: 19 },
      ]);

      const { patches } = h.history.summaryPatchesAndHidden();
      const patch = patches.get('app-history');
      assert.deepEqual(patch, {
        appSessionId: 'app-history',
        providerSessionId: 'provider-current',
        compactedFromProviderSessionIds: [
          'provider-older',
          'provider-oldest',
          'app-history',
          '',
          'provider-older',
        ],
        sessionPurpose: 'chat',
        title: 'Persisted title',
        cwd: '',
        workspaceKind: 'folder',
        configuration: droidSessionConfiguration({
          modelId: 'primary-model',
          reasoningEffort: 'high',
          interactionMode: 'auto',
          autonomy: 'high',
        }),
        droidMissionConfiguration: {
          worker: { modelId: 'worker-model', reasoningEffort: 'medium' },
          validator: { modelId: 'validator-model', reasoningEffort: 'low' },
        },
        compactionModel: 'compaction-model',
        tokensIn: 11,
        tokensOut: 12,
        contextTokens: 13,
        contextRemainingTokens: 14,
        contextAccuracy: 'exact',
        contextUpdatedAt: '2026-07-27T00:00:00.000Z',
        maxContextTokens: 15,
        autoCompactions: 16,
        updatedAt: 19,
      });
      assert.equal(patches.get('provider-current'), patch);
      assert.equal(patches.has('provider-old'), false);
      assert.deepEqual(
        h.history.summaryPatchesAndHidden().hiddenProviderSessionIds,
        new Set(['provider-older', 'provider-oldest']),
      );
    } finally {
      await h.dispose();
    }
  },
);

test('F7 create persists a distinct app id before native startup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'droidex-f7-mgr-'));
  const db = new DroidexDatabase(path.join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  const transcript = new TranscriptStore(db);
  const boundaries: string[] = [];
  const h = createSessionManagerTestContext({
    database: db,
    nextAppSessionId: () => 'app-f7',
    nextTurnId: () => 'turn-f7',
    onCreateBoundary: (boundary) => {
      boundaries.push(boundary);
      if (boundary === 'before-provider-open') {
        assert.equal(h.runtime.createCalls.length, 0);
        assert.equal(store.get('app-f7')?.lifecycleStatus, 'initializing');
      }
    },
  });

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'f7-create',
      title: 'F7',
      goal: 'hello',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    const created = h.events.find((event) => event.type === 'session.created');
    assert.equal(created?.type, 'session.created');
    if (created?.type === 'session.created') {
      assert.equal(created.session.appSessionId, 'app-f7');
      assert.notEqual(created.session.appSessionId, 'provider-1');
    }
    const persisted = boundaries.indexOf('provisional-persisted');
    const beforeOpen = boundaries.indexOf('before-provider-open');
    const bound = boundaries.indexOf('binding-persisted');
    const activated = boundaries.indexOf('activated');
    assert.notEqual(persisted, -1, 'missing create boundary: provisional-persisted');
    assert.notEqual(beforeOpen, -1, 'missing create boundary: before-provider-open');
    assert.notEqual(bound, -1, 'missing create boundary: binding-persisted');
    assert.notEqual(activated, -1, 'missing create boundary: activated');
    assert.ok(persisted < beforeOpen);
    assert.ok(bound < activated);
    assert.equal(store.get('app-f7')?.binding.providerSessionId, 'provider-1');
    assert.equal(store.get('app-f7')?.lifecycleStatus, 'running');
    assert.equal(store.findByClientRef('f7-create')?.summary.appSessionId, 'app-f7');
    await h.provider.waitForPrompts('provider-1', 1);

    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'f7-create',
      title: 'F7 replay',
      goal: 'again',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    assert.equal(h.runtime.createCalls.length, 1);
    assert.equal(transcript.page({ kind: 'session', appSessionId: 'app-f7' }).events.length, 0);
  } finally {
    await h.dispose();
    try {
      db.close();
    } catch {
      // SessionManager shutdown already closed the shared database.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F8 resume rejects a native id and does not start a second runtime', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'droidex-f8-resume-'));
  const db = new DroidexDatabase(path.join(dir, 'state', 'droidex.sqlite'));
  const store = new SessionStore(db);
  const h = createSessionManagerTestContext({
    database: db,
    nextAppSessionId: () => 'app-f8',
    nextTurnId: () => 'turn-f8',
  });
  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'f8-resume',
      title: 'F8',
      goal: 'hello',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    await h.provider.waitForPrompts('provider-1', 1);
    const loadsBefore = h.runtime.loadCalls.length;
    await h.handle({ type: 'session.resume', appSessionId: 'native-1' });
    assert.equal(h.runtime.loadCalls.length, loadsBefore);
    assert.equal(store.get('native-1'), undefined);
    assert.equal(store.get('app-f8')?.lifecycleStatus, 'running');
    assert.equal(
      h.events.some((event) => event.type === 'error' && event.appSessionId === 'native-1'),
      true,
    );
    await h.handle({ type: 'session.loadHistory', appSessionId: 'native-1' });
    assert.equal(
      h.events.some(
        (event) => event.type === 'session.history.error' && event.appSessionId === 'native-1',
      ),
      true,
    );
  } finally {
    await h.dispose();
    try {
      db.close();
    } catch {
      // SessionManager shutdown already closed the shared database.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: `Historical ${appSessionId}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

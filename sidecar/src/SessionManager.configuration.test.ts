import assert from 'node:assert/strict';
import test from 'node:test';

import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

function droidConfig(
  modelId: string,
  interactionMode: 'auto' | 'spec' | 'agi' = 'auto',
  autonomy: 'off' | 'low' | 'medium' | 'high' = 'low',
  reasoningEffort?: 'low' | 'medium' | 'high',
) {
  return droidSessionConfiguration({
    modelId,
    interactionMode,
    autonomy,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  });
}

test('a settings update cannot change the nested provider instance', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'instance-lock',
      title: 'Instance lock',
      goal: 'go',
      configuration: droidConfig('model-default'),
    });
    await h.waitForIdle();

    const nativeWritesBefore = h.provider.session('provider-1').settings.length;
    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      configuration: {
        ...droidConfig('model-default'),
        providerSelection: {
          providerInstanceId: 'codex',
          modelId: 'model-default',
          options: {},
        },
      },
    });

    assert.equal(
      h.events.some(
        (event) => event.type === 'error' && /provider instance/i.test(event.message ?? ''),
      ),
      true,
    );
    const latest = h.events.filter((event) => event.type === 'session.updated').at(-1);
    assert.equal(latest?.session.configuration.providerSelection.providerInstanceId, 'droid');
    assert.equal(h.provider.session('provider-1').settings.length, nativeWritesBefore);
  } finally {
    await h.dispose();
  }
});

test('a settings update does not mutate an in-flight turn', async () => {
  const h = createSessionManagerTestContext();
  const gate = h.runtime.deferNextCreateStream('provider-1');
  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'in-flight-config',
      title: 'In-flight',
      goal: 'first',
      configuration: droidConfig('model-default', 'auto', 'low', 'low'),
    });
    await h.provider.waitForPrompts('provider-1', 1);

    const nativeWritesBefore = h.calls.filter((call) => call.method === 'updateSettings').length;
    const specCallsBefore = h.calls.filter((call) => call.method === 'enterSpecMode').length;
    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      configuration: droidConfig('model-default', 'spec', 'high', 'high'),
    });

    assert.equal(
      h.calls.filter((call) => call.method === 'updateSettings').length,
      nativeWritesBefore,
    );
    assert.equal(h.calls.filter((call) => call.method === 'enterSpecMode').length, specCallsBefore);
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').at(-1)?.session.configuration
        .interactionMode,
      'spec',
    );
    assert.deepEqual(h.provider.session('provider-1').prompts, ['first']);
  } finally {
    gate.resolve();
    await h.dispose();
  }
});

test('replacement configuration is translated to native Droid settings exactly once before the next accepted turn', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'deferred-native',
      title: 'Deferred native',
      goal: 'first',
      configuration: droidConfig('model-default', 'auto', 'low', 'low'),
    });
    await h.waitForIdle();

    const nativeWritesAfterCreate = h.calls.filter(
      (call) => call.method === 'updateSettings',
    ).length;
    const specCallsAfterCreate = h.calls.filter((call) => call.method === 'enterSpecMode').length;
    const replacement = droidConfig('model-default', 'spec', 'high', 'high');
    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      configuration: replacement,
    });

    assert.equal(
      h.calls.filter((call) => call.method === 'updateSettings').length,
      nativeWritesAfterCreate,
    );
    assert.equal(
      h.calls.filter((call) => call.method === 'enterSpecMode').length,
      specCallsAfterCreate,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').at(-1)?.session.configuration
        .autonomy,
      'high',
    );

    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'second',
    });
    await h.provider.waitForPrompts('provider-1', 2);
    await h.waitForIdle();

    const specCalls = h.calls.filter((call) => call.method === 'enterSpecMode');
    assert.equal(specCalls.length, specCallsAfterCreate + 1);
    const nativeAfterSend = h.calls.filter((call) => call.method === 'updateSettings');
    const translated = nativeAfterSend.slice(nativeWritesAfterCreate);
    assert.ok(translated.length >= 1);
    assert.equal(
      translated.some((call) => {
        const settings = call.args[1];
        return (
          typeof settings === 'object' &&
          settings !== null &&
          'autonomyLevel' in settings &&
          settings.autonomyLevel === 'high'
        );
      }) ||
        h.provider
          .session('provider-1')
          .settings.some((settings) => settings['autonomyLevel'] === 'high'),
      true,
    );

    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'third',
    });
    await h.provider.waitForPrompts('provider-1', 3);
    await h.waitForIdle();
    assert.equal(
      h.calls.filter((call) => call.method === 'enterSpecMode').length,
      specCallsAfterCreate + 1,
    );
  } finally {
    await h.dispose();
  }
});

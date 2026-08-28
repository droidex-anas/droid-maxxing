import assert from 'node:assert/strict';
import test from 'node:test';

import { AutonomyLevel } from '@factory/droid-sdk';

import type * as Protocol from './protocol.js';
import {
  createMission,
  exactSettingsEvents,
  openChild,
  openChildForParent,
} from './testing/childSettingsTestSupport.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

function createChat(h: SessionManagerTestContext, autonomy: Protocol.Autonomy): Promise<void> {
  return h.create({
    sessionPurpose: 'chat',
    clientRef: 'autonomy-chat',
    title: 'Autonomy chat',
    goal: 'go',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy,
    }),
  });
}

function updateAutonomy(
  h: SessionManagerTestContext,
  appSessionId: string,
  autonomy: Protocol.Autonomy,
): Promise<void> {
  return h.handle({
    type: 'session.updateSettings',
    appSessionId,
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy,
    }),
  });
}

function errorEvents(events: Protocol.ServerEvent[]) {
  return events.filter((event) => event.type === 'error');
}

function sessionUpdates(events: Protocol.ServerEvent[], appSessionId: string) {
  return events.flatMap((event) =>
    event.type === 'session.updated' && event.session.appSessionId === appSessionId
      ? [event.session]
      : [],
  );
}

test('session.create without configuration fails fast without starting a provider session', async () => {
  const h = createSessionManagerTestContext();
  try {
    const command = {
      type: 'session.create',
      clientRef: 'missing-configuration',
      title: 'Missing configuration',
      goal: 'go',
      sessionPurpose: 'chat',
    } as unknown as Protocol.ClientCommand;
    await h.handle(command);

    const errors = errorEvents(h.events);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /Invalid|Required|configuration/i);
    assert.equal(
      h.events.some((event) => event.type === 'session.created'),
      false,
    );
    assert.equal(h.runtime.createCalls.length, 0);
  } finally {
    await h.dispose();
  }
});

test('live autonomy replacement publishes immediately and applies natively before the next turn', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    const nativeWritesBefore = h.provider.session('provider-1').settings.length;

    await updateAutonomy(h, 'provider-1', 'high');
    await h.waitForIdle();

    assert.equal(h.provider.session('provider-1').settings.length, nativeWritesBefore);
    assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.configuration.autonomy, 'high');

    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'next' });
    await h.provider.waitForPrompts('provider-1', 2);
    await h.waitForIdle();

    assert.deepEqual(h.provider.session('provider-1').settings.at(-1), {
      modelId: 'model-default',
      specModeModelId: 'model-default',
      autonomyLevel: AutonomyLevel.High,
      interactionMode: 'auto',
    });
    assert.equal(errorEvents(h.events).length, 0);
  } finally {
    await h.dispose();
  }
});

test('autonomy update to the current level is a no-op', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    const writesBefore = h.provider.session('provider-1').settings.length;

    await updateAutonomy(h, 'provider-1', 'low');
    await h.waitForIdle();

    assert.equal(h.provider.session('provider-1').settings.length, writesBefore);
    assert.equal(errorEvents(h.events).length, 0);
  } finally {
    await h.dispose();
  }
});

test('provider rejection on the next turn keeps the captured replacement', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    await updateAutonomy(h, 'provider-1', 'high');
    await h.waitForIdle();
    assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.configuration.autonomy, 'high');

    h.provider.session('provider-1').nextUpdateSettingsError = new Error('provider rejected');
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'next' });
    await h.waitForIdle();

    const errors = errorEvents(h.events);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /Could not apply session configuration/);
    assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.configuration.autonomy, 'high');
  } finally {
    await h.dispose();
  }
});

test('later replacements win; native Droid settings apply once before the next turn', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    const writes = h.provider.session('provider-1').settings;
    const writesBefore = writes.length;

    await updateAutonomy(h, 'provider-1', 'medium');
    await updateAutonomy(h, 'provider-1', 'high');
    await h.waitForIdle();
    assert.equal(writes.length, writesBefore);
    assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.configuration.autonomy, 'high');

    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'next' });
    await h.provider.waitForPrompts('provider-1', 2);
    await h.waitForIdle();

    const translated = writes.slice(writesBefore);
    assert.ok(translated.length >= 1);
    assert.equal(
      translated.some((settings) => settings['autonomyLevel'] === AutonomyLevel.High),
      true,
    );
    assert.equal(
      translated.some((settings) => settings['autonomyLevel'] === AutonomyLevel.Medium),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test('closing before the next turn never translates a captured replacement to native settings', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    const writesBefore = h.provider.session('provider-1').settings.length;

    await updateAutonomy(h, 'provider-1', 'high');
    await h.waitForIdle();
    assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.configuration.autonomy, 'high');

    await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    await h.waitForIdle();
    assert.equal(h.provider.session('provider-1').settings.length, writesBefore);
  } finally {
    await h.dispose();
  }
});

test('autonomy update on a session that is not live reports a recoverable error', async () => {
  const h = createSessionManagerTestContext();
  try {
    await updateAutonomy(h, 'missing-session', 'high');
    await h.waitForIdle();

    const errors = errorEvents(h.events);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /live session/);
  } finally {
    await h.dispose();
  }
});

test('child sessions publish confirmed autonomy only while their runtime is live', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);

    await openChildForParent(h, 'provider-1', {
      childSessionId: 'worker-logical',
      providerSessionId: 'provider-worker',
      role: 'worker',
      modelId: 'worker-model',
      initAutonomy: 'medium',
    });
    const opened = exactSettingsEvents(h.events, 'provider-1', 'worker-logical').at(-1);
    assert.equal(opened?.autonomy, 'medium');

    // A child whose provider did not report autonomy publishes none.
    await openChild(h, 'validator-logical', 'provider-validator', 'validator', 'validator-model');
    const unreported = exactSettingsEvents(h.events, 'provider-1', 'validator-logical').at(-1);
    assert.equal(unreported !== undefined && 'autonomy' in unreported, false);

    // Autonomy is runtime-scoped: once the runtime closes, history carries none.
    await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    await h.handle({ type: 'session.loadHistory', appSessionId: 'provider-1' });
    const history = h.events.filter((event) => event.type === 'session.history').at(-1);
    const historical =
      history?.type === 'session.history'
        ? history.childSessions?.find((child) => child.childSessionId === 'worker-logical')
        : undefined;
    assert.equal(historical !== undefined && 'autonomy' in historical, false);
  } finally {
    await h.dispose();
  }
});

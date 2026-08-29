import assert from 'node:assert/strict';
import test from 'node:test';

import { liveBindingFromSummary } from '../../SessionRegistry.js';
import { droidSessionConfiguration } from '../providerIdentity.js';
import { ProviderContractError } from '../providerTypes.js';
import { StubProviderSession } from '../../testing/stubProviderSession.js';
import { FakeFactorySession } from '../../testing/fakeFactoryRuntime.js';
import {
  FakeProviderAdapter,
  cancelingInteractionSink,
  completeFakeCapabilities,
  createTestClock,
  createTestIdSource,
} from '../testing/FakeProviderAdapter.js';
import { FakeProviderSession } from '../testing/FakeProviderSession.js';
import { UNAVAILABLE_PROVIDER_CAPABILITIES } from '../unavailableProvider.js';
import type { ProviderSessionCreateInput } from '../providerTypes.js';
import {
  hasDroidExtension,
  recoveryActionForProvider,
  requireDroidCapability,
  requireDroidExtension,
  unsupportedDroidCapabilityError,
} from './droidCapabilityGate.js';
import { stubDroidProvider } from '../../testing/droidProviderTestSupport.js';
import type { LiveSession } from '../../SessionLifecycle.js';

function createInput(
  providerInstanceId: 'droid' | 'cursor' = 'cursor',
): ProviderSessionCreateInput {
  return {
    target: { kind: 'session', appSessionId: 'app-1' },
    configuration: {
      providerSelection: { providerInstanceId, modelId: 'model-a', options: {} },
      interactionMode: 'auto',
      autonomy: 'low',
    },
    expectedGeneration: 1,
    cwd: '/tmp',
    eventSink: () => undefined,
    interactionSink: cancelingInteractionSink(),
    ids: createTestIdSource('gate'),
    clock: createTestClock(),
  };
}

function liveFor(
  provider: LiveSession['provider'],
  providerInstanceId: LiveSession['binding']['providerInstanceId'] = 'cursor',
): LiveSession {
  const factory = new FakeFactorySession('native-1', {}, []);
  const summary = {
    appSessionId: 'app-1',
    providerSessionId: factory.sessionId,
    sessionPurpose: 'chat' as const,
    role: 'user' as const,
    title: 'app-1',
    goal: 'test',
    cwd: '/tmp',
    workspaceKind: 'folder' as const,
    configuration:
      providerInstanceId === 'droid'
        ? droidSessionConfiguration({
            modelId: 'model-a',
            interactionMode: 'auto',
            autonomy: 'low',
          })
        : {
            providerSelection: { providerInstanceId, modelId: 'model-a', options: {} },
            interactionMode: 'auto' as const,
            autonomy: 'low' as const,
          },
    phase: 'paused' as const,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    summary,
    binding: { ...liveBindingFromSummary(summary), providerInstanceId },
    session: factory,
    provider,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    mcpServers: [],
    mcpConfigs: [],
  };
}

function assertUnsupported(
  error: unknown,
  expected: { providerInstanceId: string; operation: string; capability: string },
): void {
  assert.ok(error instanceof ProviderContractError);
  assert.equal(error.code, 'unsupported_capability');
  assert.equal(error.providerInstanceId, expected.providerInstanceId);
  assert.equal(
    error.recoveryAction,
    recoveryActionForProvider(expected.providerInstanceId as never),
  );
  assert.match(error.message, new RegExp(expected.operation));
  assert.match(error.message, new RegExp(expected.capability));
}

test('requireDroidExtension returns the typed extension for a Droid provider', () => {
  const factory = new FakeFactorySession('native-1', {}, []);
  const provider = stubDroidProvider(factory);
  assert.equal(hasDroidExtension(provider), true);
  const droid = requireDroidExtension(provider, 'compactSession', 'droid');
  assert.equal(typeof droid.compactSession, 'function');
});

test('requireDroidExtension fails before calling a stub provider', () => {
  const provider = new StubProviderSession('native-1');
  assert.equal(hasDroidExtension(provider), false);
  assert.throws(
    () => requireDroidExtension(provider, 'compactSession', 'cursor'),
    (error: unknown) => {
      assertUnsupported(error, {
        providerInstanceId: 'cursor',
        operation: 'compactSession',
        capability: 'droid',
      });
      return true;
    },
  );
});

test('requireDroidCapability fails a FakeProviderSession with every flag false', async () => {
  const adapter = new FakeProviderAdapter({
    providerDriverKind: 'cursor',
    providerInstanceId: 'cursor',
    displayName: 'Cursor',
  });
  adapter.snapshot.capabilities = completeFakeCapabilities({
    ...UNAVAILABLE_PROVIDER_CAPABILITIES,
    modes: ['auto'],
    autonomyLevels: ['low'],
  });
  const provider = new FakeProviderSession(adapter, createInput(), null);
  const live = liveFor(provider, 'cursor');
  const operations: Array<{
    capability:
      | 'context'
      | 'compaction'
      | 'skills'
      | 'mcpManagement'
      | 'rewind'
      | 'fork'
      | 'addressableChildren'
      | 'missionControl'
      | 'browser';
    operation: string;
  }> = [
    { capability: 'context', operation: 'getContextStats' },
    { capability: 'compaction', operation: 'compactSession' },
    { capability: 'skills', operation: 'listTools' },
    { capability: 'mcpManagement', operation: 'listMcpServers' },
    { capability: 'rewind', operation: 'executeRewind' },
    { capability: 'fork', operation: 'forkSession' },
    { capability: 'addressableChildren', operation: 'child.open' },
    { capability: 'missionControl', operation: 'applyMissionControl' },
    { capability: 'browser', operation: 'browser.open' },
  ];
  for (const { capability, operation } of operations) {
    assert.throws(
      () => requireDroidCapability(live, capability, operation, adapter.snapshot.capabilities),
      (error: unknown) => {
        assertUnsupported(error, { providerInstanceId: 'cursor', operation, capability });
        return true;
      },
    );
  }
  assert.equal(provider.calls.length, 0);
});

test('requireDroidCapability fails modelChange when unsupported', () => {
  const live = liveFor(new StubProviderSession('native-1'), 'grok');
  assert.throws(
    () =>
      requireDroidCapability(live, 'modelChange', 'updateSettings', {
        ...UNAVAILABLE_PROVIDER_CAPABILITIES,
      }),
    (error: unknown) => {
      assertUnsupported(error, {
        providerInstanceId: 'grok',
        operation: 'updateSettings',
        capability: 'modelChange',
      });
      return true;
    },
  );
});

test('requireDroidCapability uses the Droid extension when the flag is true', async () => {
  const factory = new FakeFactorySession('native-1', {}, []);
  const live = liveFor(stubDroidProvider(factory), 'droid');
  const droid = requireDroidCapability(live, 'compaction', 'compactSession');
  await droid.updateSettings({ modelId: 'other' });
  assert.equal(factory.settings.at(-1)?.modelId, 'other');
});

test('unsupportedDroidCapabilityError is a closed ProviderError', () => {
  const error = unsupportedDroidCapabilityError('claude', 'renameSession', 'droid');
  assert.equal(error.code, 'unsupported_capability');
  assert.equal(error.providerInstanceId, 'claude');
  assert.equal(error.recoveryAction, 'open_claude_setup');
  assert.match(error.message, /renameSession/);
  assert.match(error.message, /droid/);
});

test('a Droid instance missing a capability recovers with retry_session', () => {
  const error = unsupportedDroidCapabilityError('droid', 'compactSession', 'compaction');
  assert.equal(error.recoveryAction, 'retry_session');
  assert.equal(error.providerInstanceId, 'droid');
});

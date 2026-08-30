import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from '../protocol.js';
import { createProviderContractError } from './providerTypes.js';
import { FakeProviderAdapter, completeFakeCapabilities } from './testing/FakeProviderAdapter.js';
import { builtInProviderDefinition, createDefaultProviderRegistry } from './ProviderRegistry.js';
import {
  missingProviderWireSnapshot,
  publishProviderSnapshots,
  toProviderWireSnapshot,
} from './publishProviderSnapshots.js';

test('toProviderWireSnapshot omits auth labels from the renderer payload', () => {
  const adapter = new FakeProviderAdapter(builtInProviderDefinition('droid'));
  adapter.snapshot = {
    ...adapter.snapshot,
    auth: {
      accountLabel: 'hidden-account',
      apiProviderLabel: 'hidden-api',
      billingLabel: 'hidden-billing',
    },
  };
  const wire = toProviderWireSnapshot(adapter.snapshot);
  assert.equal('auth' in wire, false);
  assert.equal(wire.definition.providerInstanceId, 'droid');
  assert.equal(wire.models[0]?.id, 'model-a');
});

test('publishProviderSnapshots emits every registry slot and a fallback when probe fails', async () => {
  const droid = new FakeProviderAdapter(builtInProviderDefinition('droid'));
  const grok = new FakeProviderAdapter(builtInProviderDefinition('grok'));
  grok.snapshot = {
    ...grok.snapshot,
    models: [
      {
        id: 'grok-build',
        displayName: 'Grok Build',
        isDefault: true,
        supportedReasoningEfforts: [],
        serviceTiers: [],
      },
    ],
    capabilities: completeFakeCapabilities({
      modes: ['auto'],
      missionControl: false,
      compaction: false,
    }),
  };
  grok.gates.fail(
    'probe',
    createProviderContractError('grok', 'unavailable_provider_instance', 'boom', 'refresh'),
  );

  const registry = createDefaultProviderRegistry({
    droid: () => droid,
    grok: () => grok,
  });
  const events: ServerEvent[] = [];
  await publishProviderSnapshots({
    registry,
    emit: (event) => {
      events.push(event);
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'providers.updated');
  if (events[0]?.type !== 'providers.updated') return;
  const byId = Object.fromEntries(
    events[0].snapshots.map((snapshot) => [snapshot.definition.providerInstanceId, snapshot]),
  );
  assert.equal(byId.droid?.readiness, 'ready');
  assert.equal('auth' in (byId.droid ?? {}), false);
  assert.deepEqual(byId.grok, missingProviderWireSnapshot(builtInProviderDefinition('grok')));
  assert.equal(byId.codex?.readiness, 'missing');
  assert.equal(byId.claude?.readiness, 'missing');
  assert.equal(byId.cursor?.readiness, 'missing');
});

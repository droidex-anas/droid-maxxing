import assert from 'node:assert/strict';
import test from 'node:test';

import { CursorProviderAdapter } from './cursor/CursorAdapter.js';
import { GrokProviderAdapter } from './grok/GrokAdapter.js';
import { createHostProviderRegistry } from './hostProviderRegistry.js';
import { builtInProviderDefinition } from './ProviderRegistry.js';
import { ShutdownDeadline } from './shutdownDeadline.js';
import { FakeProviderAdapter } from './testing/FakeProviderAdapter.js';

test('the host registry wires Cursor and Grok and leaves Codex and Claude unavailable', async () => {
  const droid = new FakeProviderAdapter(builtInProviderDefinition('droid'));
  const registry = createHostProviderRegistry({ droid: () => droid });

  assert.equal(registry.resolve('droid'), droid);
  assert.equal(registry.resolve('cursor') instanceof CursorProviderAdapter, true);
  assert.equal(registry.resolve('grok') instanceof GrokProviderAdapter, true);

  const codex = await registry.refresh('codex');
  const claude = await registry.refresh('claude');
  assert.equal(codex.readiness, 'missing');
  assert.equal(claude.readiness, 'missing');
  assert.equal(codex.error?.code, 'unavailable_provider_instance');
  assert.equal(claude.error?.code, 'unavailable_provider_instance');

  await registry.close(ShutdownDeadline.fromDurationMs(1_000, 5));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClientCommand } from './protocol.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

// Bridge version skew: the socket layer JSON-parses commands without runtime
// validation, so a renderer newer than this sidecar (e.g. a dev app that kept
// running across a sidecar rebuild) can send a command this build does not
// know. The dispatch switch must answer with an actionable error instead of
// falling through silently while the renderer waits out its timeout.
test('an unknown command fails fast with a bridge.unsupported_command error', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    const skewed = { type: 'session.someFutureCommand' } as unknown as ClientCommand;
    await ctx.handle(skewed);

    const error = ctx.events.find((event) => event.type === 'error');
    assert.ok(error?.type === 'error');
    assert.equal(error.code, 'bridge.unsupported_command');
    assert.match(error.message, /someFutureCommand/);
    assert.match(error.message, /Restart the app/);
  } finally {
    await ctx.dispose();
  }
});

test('the unsupported-command error echoes the offending request id', async () => {
  // Requesters correlate on requestId; without the echo, a foreign
  // unsupported command failing concurrently would reject an unrelated
  // in-flight request (e.g. a markdown export waiting on its reply).
  const ctx = createSessionManagerTestContext();
  try {
    const skewed = {
      type: 'session.someFutureCommand',
      requestId: 'req-7',
    } as unknown as ClientCommand;
    await ctx.handle(skewed);

    const error = ctx.events.find((event) => event.type === 'error');
    assert.ok(error?.type === 'error');
    assert.equal(error.requestId, 'req-7');
  } finally {
    await ctx.dispose();
  }
});

test('a known command does not hit the unsupported-command fallback', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    await ctx.handle({ type: 'runtime.status' });

    assert.ok(ctx.events.some((event) => event.type === 'runtime.updated'));
    assert.ok(!ctx.events.some((event) => event.type === 'error'));
  } finally {
    await ctx.dispose();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { assistantTextDelta } from './testing/fakeFactoryRuntime.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';

async function waitUntilNotStreaming(
  ctx: SessionManagerTestContext,
  appSessionId: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const latest = latestSessionUpdate(ctx.events, appSessionId);
    if (latest && latest.session.streaming !== true) return;
    await ctx.waitForIdle();
  }
  throw new Error(`Session ${appSessionId} stayed streaming.`);
}

function latestSessionUpdate(
  events: ServerEvent[],
  appSessionId: string,
): Extract<ServerEvent, { type: 'session.updated' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session.updated' && event.session.appSessionId === appSessionId) {
      return event;
    }
  }
  return undefined;
}

async function createSearchableSession(
  queryText: string,
): Promise<SessionManagerTestContext> {
  const ctx = createSessionManagerTestContext();
  await ctx.create({
    sessionPurpose: 'chat',
    clientRef: `search-${queryText}`,
    title: 'Search',
    goal: 'seed',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
  });
  await ctx.provider.waitForPrompts('provider-1', 1);
  await waitUntilNotStreaming(ctx, 'provider-1');
  ctx.provider.session('provider-1').queueStreamEvents([assistantTextDelta(queryText)]);
  await ctx.handle({
    type: 'session.send',
    appSessionId: 'provider-1',
    text: 'follow-up',
  });
  await ctx.provider.waitForPrompts('provider-1', 2);
  await waitUntilNotStreaming(ctx, 'provider-1');
  return ctx;
}

test('sessions.search answers the requester from the canonical transcript store', async () => {
  const ctx = await createSearchableSession('hi bro whatsapp');
  try {
    await ctx.handle({ type: 'sessions.search', requestId: 'req-7', query: 'whatsapp' });

    const reply = ctx.events.find((event) => event.type === 'sessions.searchResults');
    assert.equal(reply?.type, 'sessions.searchResults');
    assert.equal(reply?.requestId, 'req-7');
    assert.equal(reply?.indexingIncomplete, false);
    assert.equal(reply?.results.length, 1);
    assert.equal(reply?.results[0]?.appSessionId, 'provider-1');
    assert.equal(reply?.results[0]?.matches[0]?.author, 'assistant');
    assert.equal(reply?.results[0]?.matches[0]?.snippet.includes('whatsapp'), true);
  } finally {
    await ctx.dispose();
  }
});

test('sessions.search reports complete results as soon as the store has a match', async () => {
  const ctx = await createSearchableSession('partial hit');
  try {
    await ctx.handle({ type: 'sessions.search', requestId: 'req-incomplete', query: 'partial' });

    const reply = ctx.events.find((event) => event.type === 'sessions.searchResults');
    assert.equal(reply?.type, 'sessions.searchResults');
    assert.equal(reply?.indexingIncomplete, false);
    assert.equal(reply?.results.length, 1);
    assert.equal(reply?.results[0]?.matches[0]?.snippet.includes('partial hit'), true);
  } finally {
    await ctx.dispose();
  }
});

test('a superseded sessions.search scan does not emit its results', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    // Gate the scan so the newer query lands while the older one is in
    // flight; determinism comes from the gate, not from timing.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.history.searchImpl = async (_query, isStale) => {
      await gate;
      return isStale?.()
        ? []
        : [{ appSessionId: 'app-1', matches: [{ snippet: 'hit', author: 'user', ts: 1 }] }];
    };

    const first = ctx.handle({ type: 'sessions.search', requestId: 'req-1', query: 'a' });
    const second = ctx.handle({ type: 'sessions.search', requestId: 'req-2', query: 'ab' });
    release();
    await Promise.all([first, second]);

    const replies = ctx.events.filter((event) => event.type === 'sessions.searchResults');
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.requestId, 'req-2');
  } finally {
    await ctx.dispose();
  }
});

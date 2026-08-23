import assert from 'node:assert/strict';
import test from 'node:test';

import type { PersistedChildSession } from './history.js';
import {
  HistoryPersistenceBackpressureError,
  HistoryPersistenceQueue,
} from './HistoryPersistenceQueue.js';
import type { HistoryPersistenceCall, HistoryPersistenceClient } from './HistoryWorkerClient.js';
import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
} from './historyPersistenceProtocol.js';
import type { SessionSearchResult, SessionSummary, TranscriptEvent } from './protocol.js';

class FakeClient implements HistoryPersistenceClient {
  readonly batches: HistoryPersistenceBatch[] = [];
  failNext: Error | null = null;

  startPersist(batch: HistoryPersistenceBatch): HistoryPersistenceCall<HistoryPersistenceResult> {
    this.batches.push(batch);
    const failure = this.failNext;
    this.failNext = null;
    const result: HistoryPersistenceResult = {
      durationMs: 1,
      eventsWritten: batch.events.length,
      summariesWritten: batch.summaries.length,
      childrenWritten: batch.children.length,
    };
    return {
      promise: failure ? Promise.reject(failure) : Promise.resolve(result),
      waitSync: () => {
        if (failure) throw failure;
        return result;
      },
    };
  }

  search(): Promise<SessionSearchResult[]> {
    return Promise.resolve([]);
  }

  invalidateSearch(): void {}
  closeSync(): void {}
}

function summary(appSessionId: string, tokensIn: number): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/repo',
    autonomy: 'low',
    phase: 'running',
    streaming: true,
    features: [],
    tokensIn,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function event(id: string): TranscriptEvent {
  return {
    id,
    appSessionId: 'app',
    sourceSessionId: 'app',
    role: 'primary',
    ts: 1,
    kind: 'text',
    text: id,
  };
}

function child(status: PersistedChildSession['status']): PersistedChildSession {
  return {
    parentAppSessionId: 'app',
    childSessionId: 'child',
    role: 'worker',
    status,
    modelId: 'model',
    transcriptAvailable: true,
    updatedAt: 1,
  };
}

function dormantTimer(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref();
  return timer;
}

test('keeps transcript events lossless while summaries and children collapse latest-wins', () => {
  const client = new FakeClient();
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: dormantTimer,
  });

  queue.enqueueEvent(event('one'));
  queue.enqueueSummaries([summary('app', 1)]);
  queue.enqueueEvent(event('two'));
  queue.enqueueSummaries([summary('app', 2)]);
  queue.enqueueChild(child('running'));
  queue.enqueueChild(child('paused'));
  queue.flushSync();

  assert.deepEqual(
    client.batches.flatMap((batch) => batch.events.map((item) => item.id)),
    ['one', 'two'],
  );
  assert.deepEqual(
    client.batches.flatMap((batch) => batch.summaries.map((item) => item.tokensIn)),
    [2],
  );
  assert.deepEqual(
    client.batches.flatMap((batch) => batch.children.map((item) => item.status)),
    ['paused'],
  );
});

test('restores a failed batch and preserves newer latest-wins state', () => {
  const client = new FakeClient();
  client.failNext = new Error('database busy');
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: dormantTimer,
  });

  queue.enqueueEvent(event('one'));
  queue.enqueueSummaries([summary('app', 1)]);
  assert.throws(() => queue.flushSync(), /database busy/);
  queue.enqueueSummaries([summary('app', 2)]);
  queue.flushSync();

  const successful = client.batches.at(-1);
  assert.deepEqual(
    successful?.events.map((item) => item.id),
    ['one'],
  );
  assert.deepEqual(
    successful?.summaries.map((item) => item.tokensIn),
    [2],
  );
  assert.equal(queue.snapshot().failures, 1);
});

test('large event runs preserve exact order across bounded batches', () => {
  const client = new FakeClient();
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: dormantTimer,
  });

  for (let index = 0; index < 1_500; index += 1) {
    queue.enqueueEvent(event(`event-${String(index)}`));
  }
  queue.flushSync();

  assert.deepEqual(
    client.batches.flatMap((batch) => batch.events.map((item) => item.id)),
    Array.from({ length: 1_500 }, (_, index) => `event-${String(index)}`),
  );
  assert.ok(client.batches.length >= 3);
});

test('queued values are detached from caller mutation', () => {
  const client = new FakeClient();
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: dormantTimer,
  });
  const source = summary('app', 1);
  queue.enqueueSummaries([source]);
  source.tokensIn = 99;
  source.features.push({
    id: 'queued-only',
    description: 'queued',
    status: 'pending',
    skillName: 'test',
    preconditions: [],
    expectedBehavior: [],
    verificationSteps: [],
  });
  queue.flushSync();

  assert.equal(client.batches[0]?.summaries[0]?.tokensIn, 1);
  assert.equal(client.batches[0]?.summaries[0]?.features.length, 0);
});

test('hard capacity rejects unbounded event growth', () => {
  const neverSettles: HistoryPersistenceClient = {
    startPersist: () => ({
      promise: new Promise<HistoryPersistenceResult>(() => undefined),
      waitSync: () => {
        throw new Error('not used');
      },
    }),
    search: async () => [],
    invalidateSearch: () => undefined,
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client: neverSettles,
    flushDelayMs: 60_000,
    schedule: dormantTimer,
  });

  assert.throws(() => {
    for (let index = 0; index < 50_100; index += 1) {
      queue.enqueueEvent(event(`event-${String(index)}`));
    }
  }, HistoryPersistenceBackpressureError);
});

test('a synchronous client failure becomes terminal instead of retrying forever', () => {
  const scheduledDelays: number[] = [];
  let attempts = 0;
  const terminalClient: HistoryPersistenceClient = {
    startPersist: () => {
      attempts += 1;
      throw new Error('worker exited');
    },
    search: () => Promise.resolve([]),
    invalidateSearch: () => undefined,
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client: terminalClient,
    schedule: (_callback, delayMs) => {
      scheduledDelays.push(delayMs);
      return dormantTimer();
    },
  });

  queue.enqueueEvent(event('one'));
  assert.throws(() => queue.flushSync(), /worker exited/);

  assert.equal(attempts, 1);
  assert.deepEqual(scheduledDelays, [25]);
  assert.throws(() => queue.enqueueEvent(event('two')), /worker exited/);
  assert.equal(queue.snapshot().pendingEntries, 1);
});

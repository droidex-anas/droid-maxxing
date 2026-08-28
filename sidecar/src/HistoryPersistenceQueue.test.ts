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
import { droidSessionConfiguration } from './providers/providerIdentity.js';

class FakeClient implements HistoryPersistenceClient {
  readonly batches: HistoryPersistenceBatch[] = [];
  durabilityBarriers = 0;
  failNext: Error | null = null;
  failNextBarrier: Error | null = null;

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

  startDurabilityBarrier(): HistoryPersistenceCall<{ durable: true }> {
    this.durabilityBarriers += 1;
    const failure = this.failNextBarrier;
    this.failNextBarrier = null;
    const result = { durable: true } as const;
    const promise = failure ? Promise.reject(failure) : Promise.resolve(result);
    void promise.catch(() => undefined);
    return {
      promise,
      waitSync: () => {
        if (failure) throw failure;
        return result;
      },
    };
  }

  search(): Promise<SessionSearchResult[]> {
    return Promise.resolve([]);
  }

  closeSync(): void {}
}

function summary(appSessionId: string, tokensIn: number): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/repo',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
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

test('write-behind flush timer stays unarmed until a row is queued', () => {
  const delays: number[] = [];
  const client = new FakeClient();
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (_callback, delayMs) => {
      delays.push(delayMs);
      return dormantTimer();
    },
  });

  assert.deepEqual(delays, []);
  queue.enqueueEvent(event('one'));
  assert.deepEqual(delays, [25]);
  queue.flushSync();
  assert.deepEqual(delays, [25]);
});

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
  assert.equal(client.durabilityBarriers, 1);
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

test('an asynchronous persistence failure restores events ahead of newer events', async () => {
  const callbacks: Array<() => void> = [];
  const persistedIds: string[][] = [];
  let attempts = 0;
  let rejectFirst: ((error: Error) => void) | undefined;
  const client: HistoryPersistenceClient = {
    startPersist: (batch) => {
      attempts += 1;
      persistedIds.push(batch.events.map((item) => item.id));
      const result: HistoryPersistenceResult = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      if (attempts > 1) return { promise: Promise.resolve(result), waitSync: () => result };
      const promise = new Promise<HistoryPersistenceResult>((_resolve, reject) => {
        rejectFirst = reject;
      });
      return {
        promise,
        waitSync: () => {
          throw new Error('not used');
        },
      };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (callback) => {
      callbacks.push(callback);
      return dormantTimer();
    },
  });

  queue.enqueueEvent(event('one'));
  callbacks.shift()?.();
  queue.enqueueEvent(event('two'));
  rejectFirst?.(new Error('worker exited'));
  await Promise.resolve();
  callbacks.shift()?.();
  await Promise.resolve();

  assert.deepEqual(persistedIds, [['one'], ['one', 'two']]);
  assert.equal(queue.snapshot().pendingEntries, 0);
});

test('an asynchronous drain never enters the synchronous worker wait', async () => {
  let resolvePersist: ((result: HistoryPersistenceResult) => void) | undefined;
  let synchronousWaits = 0;
  const client: HistoryPersistenceClient = {
    startPersist: () => {
      const promise = new Promise<HistoryPersistenceResult>((resolve) => {
        resolvePersist = resolve;
      });
      return {
        promise,
        waitSync: () => {
          synchronousWaits += 1;
          throw new Error('synchronous wait must not run');
        },
      };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: dormantTimer,
  });
  queue.enqueueEvent(event('one'));

  const draining = queue.drain();
  await Promise.resolve();
  assert.equal(synchronousWaits, 0);
  assert.equal(queue.snapshot().inFlightEntries, 1);

  resolvePersist?.({
    durationMs: 1,
    eventsWritten: 1,
    summariesWritten: 0,
    childrenWritten: 0,
  });
  await draining;
  assert.equal(queue.snapshot().pendingEntries, 0);
  assert.equal(queue.snapshot().inFlightEntries, 0);
});

test('an asynchronous drain waits only for entries captured when it starts', async () => {
  let resolveFirst: ((result: HistoryPersistenceResult) => void) | undefined;
  let resolveSecond: ((result: HistoryPersistenceResult) => void) | undefined;
  let markSecondStarted: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let calls = 0;
  const client: HistoryPersistenceClient = {
    startPersist: (batch) => {
      calls += 1;
      const promise = new Promise<HistoryPersistenceResult>((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else {
          resolveSecond = resolve;
          markSecondStarted?.();
        }
      });
      return {
        promise,
        waitSync: () => ({
          durationMs: 1,
          eventsWritten: batch.events.length,
          summariesWritten: batch.summaries.length,
          childrenWritten: batch.children.length,
        }),
      };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: dormantTimer,
  });
  queue.enqueueEvent(event('captured'));
  let drainFinished = false;
  const draining = queue.drain().then(() => {
    drainFinished = true;
  });
  queue.enqueueEvent(event('newer'));
  resolveFirst?.({
    durationMs: 1,
    eventsWritten: 1,
    summariesWritten: 0,
    childrenWritten: 0,
  });
  await secondStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(drainFinished, true, 'new writes do not extend the captured drain barrier');
  } finally {
    resolveSecond?.({
      durationMs: 1,
      eventsWritten: 1,
      summariesWritten: 0,
      childrenWritten: 0,
    });
    await draining;
    queue.close();
  }
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
    startDurabilityBarrier: () => {
      throw new Error('not used');
    },
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

test('a synchronous worker failure retains queued events and accepts live output until recovery', () => {
  const scheduledDelays: number[] = [];
  const scheduledCallbacks: Array<() => void> = [];
  const persistedIds: string[][] = [];
  let attempts = 0;
  const recoveringClient: HistoryPersistenceClient = {
    startPersist: (batch) => {
      attempts += 1;
      if (attempts === 1) throw new Error('worker exited');
      persistedIds.push(batch.events.map((item) => item.id));
      const result: HistoryPersistenceResult = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client: recoveringClient,
    schedule: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      scheduledCallbacks.push(callback);
      return dormantTimer();
    },
  });

  queue.enqueueEvent(event('one'));
  scheduledCallbacks.shift()?.();
  assert.doesNotThrow(() => queue.enqueueEvent(event('two')));
  queue.flushSync();

  assert.equal(attempts, 2);
  assert.deepEqual(scheduledDelays, [25, 250]);
  assert.deepEqual(persistedIds, [['one', 'two']]);
  assert.equal(queue.snapshot().pendingEntries, 0);
});

test('repeated worker failures retry with bounded exponential backoff', () => {
  const delays: number[] = [];
  const callbacks: Array<() => void> = [];
  let attempts = 0;
  const client: HistoryPersistenceClient = {
    startPersist: (batch) => {
      attempts += 1;
      if (attempts <= 8) throw new Error('worker unavailable');
      const result: HistoryPersistenceResult = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return dormantTimer();
    },
  });

  queue.enqueueEvent(event('one'));
  for (let index = 0; index < 8; index += 1) callbacks.shift()?.();

  assert.deepEqual(delays, [25, 250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
});

test('a failed durability barrier retries without waiting for another write', async () => {
  const callbacks: Array<() => void> = [];
  const statuses: string[] = [];
  const client = new FakeClient();
  client.failNextBarrier = new Error('checkpoint failed');
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (callback) => {
      callbacks.push(callback);
      return dormantTimer();
    },
    onFailure: () => statuses.push('degraded'),
    onRecovered: () => statuses.push('healthy'),
  });

  queue.enqueueEvent(event('one'));
  assert.throws(() => queue.flushSync(), /checkpoint failed/);
  callbacks.at(-1)?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(statuses, ['degraded', 'healthy']);
  assert.equal(client.durabilityBarriers, 2);
});

test('a consistency drain preserves a pending durability retry', async () => {
  const callbacks: Array<() => void> = [];
  const statuses: string[] = [];
  const client = new FakeClient();
  client.failNextBarrier = new Error('checkpoint failed');
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (callback) => {
      callbacks.push(callback);
      return dormantTimer();
    },
    onFailure: () => statuses.push('degraded'),
    onRecovered: () => statuses.push('healthy'),
  });

  queue.enqueueEvent(event('one'));
  assert.throws(() => queue.flushSync(), /checkpoint failed/);
  await queue.drain();
  callbacks.at(-1)?.();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(statuses, ['degraded', 'healthy']);
});

test('a failed boundary drain stays degraded until a later barrier succeeds', async () => {
  const callbacks: Array<() => void> = [];
  const statuses: string[] = [];
  const client = new FakeClient();
  client.failNext = new Error('worker failed during boundary');
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (callback) => {
      callbacks.push(callback);
      return dormantTimer();
    },
    onFailure: () => statuses.push('degraded'),
    onRecovered: () => statuses.push('healthy'),
  });

  queue.enqueueEvent(event('one'));
  assert.throws(() => queue.flushSync(), /worker failed during boundary/);
  callbacks.at(-1)?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(statuses, ['degraded', 'healthy']);
});

test('a failed close cancels the retry it scheduled before closing the client', () => {
  const callbacks: Array<() => void> = [];
  const cancelled = new Set<ReturnType<typeof setTimeout>>();
  const client = new FakeClient();
  client.failNextBarrier = new Error('checkpoint failed during close');
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: (callback) => {
      callbacks.push(callback);
      return dormantTimer();
    },
    cancel: (timer) => {
      cancelled.add(timer);
      clearTimeout(timer);
    },
  });

  queue.enqueueEvent(event('one'));
  assert.throws(() => queue.close(), /checkpoint failed during close/);
  assert.equal(callbacks.length, 2, 'the initial flush and failed-barrier retry were scheduled');
  assert.equal(cancelled.size, 2, 'both timers were cancelled before close returned');
  const barriersBeforeStaleCallback = client.durabilityBarriers;
  callbacks.at(-1)?.();
  assert.equal(client.durabilityBarriers, barriersBeforeStaleCallback);
});

test('unflushed work is marked dirty until a successful drain, then reported rather than assumed durable', () => {
  const client = new FakeClient();
  const marks: string[] = [];
  const queue = new HistoryPersistenceQueue({
    dbPath: '/unused',
    client,
    schedule: () => dormantTimer(),
    cancel: (timer) => {
      clearTimeout(timer);
    },
    dirtyMarker: {
      markDirty: () => marks.push('dirty'),
      markClean: () => marks.push('clean'),
    },
  });
  queue.enqueueEvent(event('one'));
  assert.deepEqual(marks, ['dirty']);
  queue.flushSync();
  assert.ok(marks.includes('clean'));
  queue.close();
});

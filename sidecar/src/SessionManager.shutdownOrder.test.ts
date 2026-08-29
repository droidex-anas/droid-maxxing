import assert from 'node:assert/strict';
import test from 'node:test';

import { ChildSessions } from './ChildSessions.js';
import { MissionControlPolicy } from './MissionControlPolicy.js';
import { SessionLifecycle } from './SessionLifecycle.js';
import { SessionTimeline } from './SessionTimeline.js';
import { SessionInteractions } from './SessionInteractions.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import { ProviderRegistry } from './providers/ProviderRegistry.js';
import { FakeProviderAdapter } from './providers/testing/FakeProviderAdapter.js';
import { builtInProviderDefinition } from './providers/ProviderRegistry.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

function controllablePromise(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test(
  'shutdown runs children before parents and Mission policy after both',
  { concurrency: false },
  async () => {
    const order: string[] = [];
    const closeAll = SessionLifecycle.prototype.closeAll;
    const shutdownChildren = ChildSessions.prototype.shutdown;
    const clearMission = MissionControlPolicy.prototype.clear;
    SessionLifecycle.prototype.closeAll = async function (deadline) {
      order.push('lifecycle.closeAll');
      await closeAll.call(this, deadline);
    };
    ChildSessions.prototype.shutdown = async function (deadline) {
      order.push('children.shutdown');
      await shutdownChildren.call(this, deadline);
    };
    MissionControlPolicy.prototype.clear = function () {
      order.push('mission.clear');
      clearMission.call(this);
    };

    const harness = createSessionManagerTestContext();
    try {
      await harness.shutdown();
      assert.deepEqual(order, ['children.shutdown', 'lifecycle.closeAll', 'mission.clear']);
    } finally {
      SessionLifecycle.prototype.closeAll = closeAll;
      ChildSessions.prototype.shutdown = shutdownChildren;
      MissionControlPolicy.prototype.clear = clearMission;
      await harness.dispose();
    }
  },
);

test(
  'timeline flush precedes SQLite close',
  { concurrency: false },
  async () => {
    const order: string[] = [];
    const flushStreaming = SessionTimeline.prototype.flushStreaming;
    SessionTimeline.prototype.flushStreaming = function (deadline) {
      order.push('timeline.flushStreaming');
      flushStreaming.call(this, deadline);
    };

    const database = {
      close: () => {
        order.push('database.close');
      },
    };
    const harness = createSessionManagerTestContext({ database });
    try {
      await harness.shutdown();
      assert.deepEqual(order, ['timeline.flushStreaming', 'database.close']);
    } finally {
      SessionTimeline.prototype.flushStreaming = flushStreaming;
      await harness.dispose();
    }
  },
);

test(
  'the exact same deadline object reaches every shutdown layer',
  { concurrency: false },
  async () => {
    const deadline = ShutdownDeadline.fromDurationMs(4_000, 10);
    const received: Array<[string, unknown]> = [];
    const droid = new FakeProviderAdapter(builtInProviderDefinition('droid'));
    const providerRegistry = new ProviderRegistry([
      { definition: droid.definition, createAdapter: () => droid },
    ]);
    providerRegistry.resolve('droid');

    const closeAll = SessionLifecycle.prototype.closeAll;
    const shutdownChildren = ChildSessions.prototype.shutdown;
    const flushStreaming = SessionTimeline.prototype.flushStreaming;
    SessionLifecycle.prototype.closeAll = async function (receivedDeadline) {
      received.push(['lifecycle.closeAll', receivedDeadline]);
      await closeAll.call(this, receivedDeadline);
    };
    ChildSessions.prototype.shutdown = async function (receivedDeadline) {
      received.push(['children.shutdown', receivedDeadline]);
      await shutdownChildren.call(this, receivedDeadline);
    };
    SessionTimeline.prototype.flushStreaming = function (receivedDeadline) {
      received.push(['timeline.flushStreaming', receivedDeadline]);
      flushStreaming.call(this, receivedDeadline);
    };

    const database = {
      close: (receivedDeadline?: ShutdownDeadline) => {
        received.push(['database.close', receivedDeadline]);
      },
    };
    const harness = createSessionManagerTestContext({ providerRegistry, database });
    try {
      await harness.shutdown(deadline);
      assert.equal(droid.receivedCloseDeadline, deadline);
      for (const [, receivedDeadline] of received) {
        assert.equal(receivedDeadline, deadline);
      }
      assert.deepEqual(
        received.map(([name]) => name),
        ['children.shutdown', 'lifecycle.closeAll', 'timeline.flushStreaming', 'database.close'],
      );
    } finally {
      SessionLifecycle.prototype.closeAll = closeAll;
      ChildSessions.prototype.shutdown = shutdownChildren;
      SessionTimeline.prototype.flushStreaming = flushStreaming;
      await harness.dispose();
    }
  },
);

test(
  'live generations invalidate before provider close awaits',
  { concurrency: false },
  async () => {
    const order: string[] = [];
    const invalidate = SessionLifecycle.prototype.invalidateLiveSessions;
    const closeAll = SessionLifecycle.prototype.closeAll;
    SessionLifecycle.prototype.invalidateLiveSessions = function () {
      order.push('lifecycle.invalidateLiveSessions');
      return invalidate.call(this);
    };
    SessionLifecycle.prototype.closeAll = async function (deadline) {
      order.push('lifecycle.closeAll');
      await closeAll.call(this, deadline);
    };
    const harness = createSessionManagerTestContext();
    try {
      await harness.shutdown();
      assert.equal(order[0], 'lifecycle.invalidateLiveSessions');
      assert.ok(order.indexOf('lifecycle.closeAll') > 0);
    } finally {
      SessionLifecycle.prototype.invalidateLiveSessions = invalidate;
      SessionLifecycle.prototype.closeAll = closeAll;
      await harness.dispose();
    }
  },
);

test('command admission stops before any cleanup await', { concurrency: false }, async () => {
  const gate = controllablePromise();
  const closeAll = SessionLifecycle.prototype.closeAll;
  SessionLifecycle.prototype.closeAll = async function (deadline) {
    await gate.promise;
    await closeAll.call(this, deadline);
  };
  const harness = createSessionManagerTestContext();
  try {
    const shuttingDown = harness.shutdown();
    await assert.rejects(
      harness.handle({ type: 'sessions.list' }),
      /Session manager is shutting down/,
    );
    gate.resolve();
    await shuttingDown;
  } finally {
    SessionLifecycle.prototype.closeAll = closeAll;
    await harness.dispose();
  }
});

test(
  'discovery abort happens before adapter close and a late refresh is discarded',
  { concurrency: false },
  async () => {
    const droid = new FakeProviderAdapter(builtInProviderDefinition('droid'));
    droid.gates.block('probe');
    const providerRegistry = new ProviderRegistry([
      { definition: droid.definition, createAdapter: () => droid },
    ]);
    const pending = providerRegistry.refresh('droid');
    await droid.gates.waitUntilBlocked('probe');
    const harness = createSessionManagerTestContext({ providerRegistry });
    const deadline = ShutdownDeadline.fromDurationMs(1_000, 20);
    try {
      const shuttingDown = harness.shutdown(deadline);
      droid.snapshot = { ...droid.snapshot, readiness: 'unauthenticated' };
      droid.gates.release('probe');
      await assert.rejects(pending, /cancelled|stale/);
      await shuttingDown;
      assert.equal(providerRegistry.snapshot('droid'), undefined);
      assert.equal(droid.receivedCloseDeadline, deadline);
    } finally {
      await harness.dispose();
    }
  },
);

test(
  'interaction callbacks settle before native provider close',
  { concurrency: false },
  async () => {
    const order: string[] = [];
    const cancelAll = SessionInteractions.prototype.cancelAllPending;
    SessionInteractions.prototype.cancelAllPending = function () {
      order.push('interactions.cancelAllPending');
      cancelAll.call(this);
    };
    const closeAll = SessionLifecycle.prototype.closeAll;
    SessionLifecycle.prototype.closeAll = async function (deadline) {
      order.push('lifecycle.closeAll');
      await closeAll.call(this, deadline);
    };
    const shutdownChildren = ChildSessions.prototype.shutdown;
    ChildSessions.prototype.shutdown = async function (deadline) {
      order.push('children.shutdown');
      await shutdownChildren.call(this, deadline);
    };

    const harness = createSessionManagerTestContext();
    try {
      await harness.create({
        sessionPurpose: 'chat',
        clientRef: 'settle-before-close',
        title: 'Settle',
        goal: 'go',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      });
      await harness.waitForIdle();
      const permissionHandler = harness.provider.session('provider-1').handlers.permissionHandler;
      assert.ok(permissionHandler);
      let settled = false;
      const pending = Promise.resolve(
        permissionHandler({
          toolUses: [
            {
              toolUse: { type: 'tool_use', id: 'shutdown-approval', name: 'Bash', input: {} },
              confirmationType: 'execute',
              details: { type: 'execute', command: 'pwd', fullCommand: 'pwd' },
            },
          ],
        } as never),
      ).then(() => {
        settled = true;
      });
      await harness.waitForIdle();
      const shutdown = harness.shutdown();
      await pending;
      await shutdown;
      assert.equal(settled, true);
      assert.deepEqual(order, [
        'interactions.cancelAllPending',
        'children.shutdown',
        'lifecycle.closeAll',
      ]);
    } finally {
      SessionInteractions.prototype.cancelAllPending = cancelAll;
      SessionLifecycle.prototype.closeAll = closeAll;
      ChildSessions.prototype.shutdown = shutdownChildren;
      await harness.dispose();
    }
  },
);

test('a failing cleanup step still runs every later step', { concurrency: false }, async () => {
  const order: string[] = [];
  const closeAll = SessionLifecycle.prototype.closeAll;
  SessionLifecycle.prototype.closeAll = async function () {
    order.push('lifecycle.closeAll');
    throw new Error('lifecycle failed');
  };
  const flushStreaming = SessionTimeline.prototype.flushStreaming;
  SessionTimeline.prototype.flushStreaming = function (deadline) {
    order.push('timeline.flushStreaming');
    flushStreaming.call(this, deadline);
  };
  const database = {
    close: () => {
      order.push('database.close');
    },
  };
  const harness = createSessionManagerTestContext({ database });
  try {
    await assert.rejects(harness.shutdown(), /lifecycle failed/);
    assert.deepEqual(order, ['lifecycle.closeAll', 'timeline.flushStreaming', 'database.close']);
  } finally {
    SessionLifecycle.prototype.closeAll = closeAll;
    SessionTimeline.prototype.flushStreaming = flushStreaming;
    await harness.dispose();
  }
});

test('an already-expired deadline still attempts cleanup and does not wait', async () => {
  const hanging = controllablePromise();
  const closeAll = SessionLifecycle.prototype.closeAll;
  SessionLifecycle.prototype.closeAll = async function () {
    await hanging.promise;
  };
  const database = {
    close: () => {
      closed = true;
    },
  };
  let closed = false;
  const harness = createSessionManagerTestContext({ database });
  try {
    await harness.shutdown(ShutdownDeadline.fromDurationMs(0));
    assert.equal(closed, true);
  } finally {
    hanging.resolve();
    SessionLifecycle.prototype.closeAll = closeAll;
    await harness.dispose();
  }
});

test('repeated shutdown triggers share one promise', async () => {
  const harness = createSessionManagerTestContext();
  try {
    const first = harness.shutdown();
    const second = harness.shutdown();
    assert.equal(first, second);
    await first;
  } finally {
    await harness.dispose();
  }
});

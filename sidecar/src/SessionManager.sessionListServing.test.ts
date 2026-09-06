import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionFileWatcherOptions } from './sessionFileWatcher.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import {
  providerSessionJsonl,
  type ProviderMessageRole,
} from './testing/providerSessionFixtures.js';

// Writes a session file with no app involvement, like a Droid CLI run or a
// parallel app instance would.
function writeExternalSession(
  home: string,
  id: string,
  cwd: string,
  messageRoles: ProviderMessageRole[] = ['user', 'assistant'],
): void {
  const dir = join(home, '.factory', 'sessions', '2026', '08');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    providerSessionJsonl(
      {
        type: 'session_start',
        cwd,
        sessionTitle: 'External CLI session',
        settings: { interactionMode: 'auto' },
      },
      messageRoles,
    ),
  );
}

test('sessions created outside the app are republished live when the watcher fires', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  let watcherClosed = false;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return {
        consumeLiveSessionFile: () => undefined,
        close: () => {
          watcherClosed = true;
        },
      };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    assert.ok(watcherOptions, 'watcher starts on the first sessions.list');
    const listsBefore = ctx.events.filter((event) => event.type === 'sessions.list').length;

    writeExternalSession(ctx.home, 'external-session-1', '/tmp/external-workspace');
    const sessionFile = join(
      ctx.home,
      '.factory',
      'sessions',
      '2026',
      '08',
      'external-session-1.jsonl',
    );
    watcherOptions.onExternalChange([
      { providerSessionId: 'external-session-1', path: sessionFile },
    ]);
    await ctx.waitForIdle();

    assert.deepEqual(
      ctx.history.targetedReconcileCalls,
      [[{ providerSessionId: 'external-session-1', path: sessionFile }]],
      'a targeted change list reconciles exactly the reported file',
    );
    assert.equal(ctx.history.fullReconcileCalls, 1, 'only the boot reconcile walks the tree');

    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, listsBefore + 1, 'external change republishes the list');
    const republished = lists.at(-1);
    assert.equal(republished?.type, 'sessions.list');
    assert.ok(
      republished?.sessions.some((session) => session.appSessionId === 'external-session-1'),
      'republished list includes the externally created session',
    );
  } finally {
    await ctx.dispose();
  }
  assert.equal(watcherClosed, true, 'watcher closes on shutdown');
});

test('metadata-only sessions created outside the app never become sidebar rows', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    writeExternalSession(ctx.home, 'empty-external-session', '/tmp/external-workspace', []);
    const sessionFile = join(
      ctx.home,
      '.factory',
      'sessions',
      '2026',
      '08',
      'empty-external-session.jsonl',
    );

    watcherOptions?.onExternalChange([
      { providerSessionId: 'empty-external-session', path: sessionFile },
    ]);

    const list = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(list?.type === 'sessions.list');
    assert.equal(
      list.sessions.some((session) => session.appSessionId === 'empty-external-session'),
      false,
    );
  } finally {
    await ctx.dispose();
  }
});

test('a live first turn stays visible before the provider writes its response', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    await ctx.create({
      cwd: '/tmp/live-first-turn',
      sessionPurpose: 'chat',
      clientRef: 'live-first-turn',
      title: 'Live first turn',
      goal: 'hello',
      interactionMode: 'auto',
      autonomy: 'low',
    });

    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/tmp/live-first-turn'] });

    const created = ctx.events.find((event) => event.type === 'session.created');
    const list = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(created?.type === 'session.created');
    assert.ok(list?.type === 'sessions.list');
    assert.ok(
      list.sessions.some((session) => session.appSessionId === created.session.appSessionId),
    );
  } finally {
    await ctx.dispose();
  }
});

test('unexplained watcher events fall back to a full reconcile before republishing', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    assert.ok(watcherOptions, 'watcher starts on the first sessions.list');
    const fullReconcilesBefore = ctx.history.fullReconcileCalls;

    watcherOptions.onExternalChange(null);
    await ctx.waitForIdle();

    assert.equal(
      ctx.history.fullReconcileCalls,
      fullReconcilesBefore + 1,
      'a null change list runs a full reconcile',
    );
    assert.equal(ctx.history.targetedReconcileCalls.length, 0);
  } finally {
    await ctx.dispose();
  }
});

test('a failed watcher reconcile marks the next list for an authoritative full retry', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    const listsBefore = ctx.events.filter((event) => event.type === 'sessions.list').length;
    ctx.history.failNextTargetedReconcile = new Error('derived database busy');
    watcherOptions?.onExternalChange([
      { providerSessionId: 'failed-watcher-session', path: '/tmp/failed-watcher.jsonl' },
    ]);
    await ctx.waitForIdle();

    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      listsBefore,
      'a failed delta never republishes a stale list',
    );
    await ctx.handle({ type: 'sessions.list' });
    assert.equal(ctx.history.fullReconcileCalls, 2, 'the next list performs a full retry');
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      listsBefore + 1,
    );
  } finally {
    await ctx.dispose();
  }
});

test('closing a live session reconciles its final file before republishing', async () => {
  const workspace = '/tmp/finalized-workspace';
  let finalizedSessionFile: string | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: () => ({
      consumeLiveSessionFile: () => finalizedSessionFile,
      close: () => {},
    }),
  });
  try {
    await ctx.create({
      cwd: workspace,
      sessionPurpose: 'chat',
      clientRef: 'finalized-session',
      title: 'Finalized session',
      goal: 'finish',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    writeExternalSession(ctx.home, 'provider-1', workspace);
    finalizedSessionFile = join(ctx.home, '.factory', 'sessions', '2026', '08', 'provider-1.jsonl');
    await ctx.handle({ type: 'sessions.list', workspaceCwds: [workspace] });
    const reconcilesBeforeClose = ctx.history.fullReconcileCalls;
    const targetedReconcilesBeforeClose = ctx.history.targetedReconcileCalls.length;

    await ctx.handle({ type: 'session.close', appSessionId: 'provider-1' });

    assert.equal(
      ctx.history.fullReconcileCalls,
      reconcilesBeforeClose,
      'an observed live file does not trigger a full sessions-tree walk on close',
    );
    assert.deepEqual(
      ctx.history.targetedReconcileCalls.slice(targetedReconcilesBeforeClose),
      [[{ providerSessionId: 'provider-1', path: finalizedSessionFile }]],
      'close reconciles only the finalized file after the live registry entry is removed',
    );
    const list = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(list?.type === 'sessions.list');
    assert.ok(
      list.sessions.some((session) => session.appSessionId === 'provider-1'),
      'the post-close list retains the newly historical session',
    );
    assert.ok(
      list.sessions.every((session) => session.cwd === workspace),
      'the post-close list preserves the renderer active workspace filter',
    );
  } finally {
    await ctx.dispose();
  }
});

test('provider replacement finalizes the retired file without treating its alias as live', async () => {
  const consumedProviderSessionIds: string[] = [];
  const retiredPath = '/tmp/provider-1.jsonl';
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: () => ({
      consumeLiveSessionFile: (providerSessionId) => {
        consumedProviderSessionIds.push(providerSessionId);
        return providerSessionId === 'provider-1' ? retiredPath : undefined;
      },
      close: () => {},
    }),
  });
  try {
    await ctx.create({
      cwd: '/tmp/compacted-workspace',
      sessionPurpose: 'chat',
      clientRef: 'compacted-session',
      title: 'Compacted session',
      goal: 'compact',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await ctx.handle({ type: 'sessions.list' });
    const targetedBefore = ctx.history.targetedReconcileCalls.length;
    ctx.provider.session('provider-1').nextCompactResult = {
      newSessionId: 'provider-2',
      removedCount: 1,
    };
    ctx.runtime.loadQueue.set('provider-2', [new FakeFactorySession('provider-2', {}, ctx.calls)]);

    await ctx.handle({ type: 'session.compact', appSessionId: 'provider-1' });
    await ctx.waitForIdle();

    assert.deepEqual(consumedProviderSessionIds, ['provider-1']);
    assert.deepEqual(ctx.history.targetedReconcileCalls.slice(targetedBefore), [
      [{ providerSessionId: 'provider-1', path: retiredPath }],
    ]);
  } finally {
    await ctx.dispose();
  }
});

test('the watcher starts once per boot, not per sessions.list command', async () => {
  let starts = 0;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: () => {
      starts += 1;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    await ctx.handle({ type: 'sessions.list' });
    await ctx.handle({ type: 'sessions.list' });
    assert.equal(starts, 1);
  } finally {
    await ctx.dispose();
  }
});

test('history idle commands forward the exact desktop activity state', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    await ctx.handle({ type: 'history.indexingIdle', isIdle: true });
    await ctx.handle({ type: 'history.indexingIdle', isIdle: false });

    assert.deepEqual(ctx.history.indexingIdleStates, [true, false]);
  } finally {
    await ctx.dispose();
  }
});

test('the first sessions.list resolves only after the boot reconcile publishes', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    ctx.history.sessionFileCacheSize = 2;
    writeExternalSession(ctx.home, 'boot-external-session', '/tmp/boot-workspace');

    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      1,
      'the command resolves after publishing the reconciled list',
    );

    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, 1, 'the first list is emitted once the boot reconcile settles');
    assert.equal(ctx.history.fullReconcileCalls, 1, 'the boot reconcile ran exactly once');
    assert.ok(
      lists[0]?.sessions.some((session) => session.appSessionId === 'boot-external-session'),
      'the first list already includes sessions created while the app was away',
    );

    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      2,
      'lists after the boot reconcile are served immediately',
    );
  } finally {
    await ctx.dispose();
  }
});

test('sessions.list commands queued during the boot reconcile emit only the latest', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    ctx.history.sessionFileCacheSize = 2;
    writeExternalSession(ctx.home, 'queued-first-session', '/tmp/first');
    writeExternalSession(ctx.home, 'queued-second-session', '/tmp/second');
    const first = ctx.handle({ type: 'sessions.list', workspaceCwds: ['/tmp/first'] });
    const second = ctx.handle({ type: 'sessions.list', workspaceCwds: ['/tmp/second'] });
    await Promise.all([first, second]);
    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, 1, 'only the latest queued request emits after the reconcile');
    assert.equal(ctx.history.fullReconcileCalls, 1);
    assert.ok(
      lists[0]?.sessions.some((session) => session.appSessionId === 'queued-second-session'),
      'the emit uses the latest request filter',
    );
    assert.equal(
      lists[0]?.sessions.some((session) => session.appSessionId === 'queued-first-session'),
      false,
      'the superseded request filter is not used',
    );
  } finally {
    await ctx.dispose();
  }
});

test('a boot reconcile failure rejects the stale list and retries on the next request', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    ctx.history.sessionFileCacheSize = 2;
    ctx.history.failNextReconcile = new Error('sqlite busy');
    await assert.rejects(ctx.handle({ type: 'sessions.list' }), /sqlite busy/);
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      0,
      'a failed authoritative reconcile never publishes stale history',
    );

    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      1,
      'the next request retries and publishes once the cache is authoritative',
    );
    assert.equal(ctx.history.fullReconcileCalls, 2);
  } finally {
    await ctx.dispose();
  }
});

test('a seeded cwd patch is respected before workspace filtering', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    // The on-disk session belongs to workspace A...
    writeExternalSession(ctx.home, 'moved-session', '/workspace-on-disk');
    // ...but a persisted app-session patch moves it to workspace B.
    ctx.fixture.seedHistorySummaries([
      {
        appSessionId: 'moved-session',
        providerSessionId: 'moved-session',
        sessionPurpose: 'chat',
        interactionMode: 'auto',
        role: 'primary',
        title: 'Moved session',
        goal: 'Moved session',
        cwd: '/workspace-patched',
        workspaceKind: 'folder',
        autonomy: 'low',
        phase: 'paused',
        features: [],
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/workspace-patched'] });
    const list = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(list?.type === 'sessions.list');
    assert.ok(
      list.sessions.some((session) => session.appSessionId === 'moved-session'),
      'a session whose patched cwd matches the requested workspace is listed',
    );

    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/workspace-on-disk'] });
    const onDiskList = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(onDiskList?.type === 'sessions.list');
    assert.equal(
      onDiskList.sessions.some((session) => session.appSessionId === 'moved-session'),
      false,
      'the session no longer belongs to its pre-patch workspace',
    );
  } finally {
    await ctx.dispose();
  }
});

test('a watcher event during the worker boot reconcile is replayed before the first list', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    ctx.history.sessionFileCacheSize = 2;
    writeExternalSession(ctx.home, 'boot-window-session', '/tmp/boot-window');
    const firstList = ctx.handle({
      type: 'sessions.list',
      workspaceCwds: ['/tmp/boot-window'],
    });
    // The boot reconcile is still pending. Changes in this window are held
    // and replayed after the full scan because the scan may already have
    // passed the changed path.
    const sessionFile = join(
      ctx.home,
      '.factory',
      'sessions',
      '2026',
      '08',
      'boot-window-session.jsonl',
    );
    watcherOptions!.onExternalChange([
      { providerSessionId: 'boot-window-session', path: sessionFile },
    ]);
    assert.equal(
      ctx.history.fullReconcileCalls,
      0,
      'a watcher reconcile is not scheduled during the boot window',
    );
    await firstList;
    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, 1, 'only the authoritative boot reconcile list is emitted');
    assert.equal(ctx.history.fullReconcileCalls, 1);
    assert.deepEqual(ctx.history.targetedReconcileCalls, [
      [{ providerSessionId: 'boot-window-session', path: sessionFile }],
    ]);
  } finally {
    await ctx.dispose();
  }
});

test('shutdown waits for an active watcher reconcile and suppresses its republish', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  let releaseReconcile: (() => void) | undefined;
  let markReconcileStarted: (() => void) | undefined;
  const reconcileStarted = new Promise<void>((resolve) => {
    markReconcileStarted = resolve;
  });
  const reconcileGate = new Promise<void>((resolve) => {
    releaseReconcile = resolve;
  });
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    const reconcile = ctx.history.reconcileSessionFilePaths.bind(ctx.history);
    ctx.history.reconcileSessionFilePaths = async (changes) => {
      await reconcile(changes);
      markReconcileStarted?.();
      await reconcileGate;
      return 0;
    };
    const listsBefore = ctx.events.filter((event) => event.type === 'sessions.list').length;

    watcherOptions!.onExternalChange([
      { providerSessionId: 'external-during-shutdown', path: '/tmp/external.jsonl' },
    ]);
    await reconcileStarted;
    let shutdownSettled = false;
    const shutdown = ctx.shutdown().then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false, 'history stays open until the active reconcile settles');

    releaseReconcile?.();
    await shutdown;
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      listsBefore,
      'a reconcile that finishes during shutdown does not publish renderer state',
    );
  } finally {
    releaseReconcile?.();
    await ctx.dispose();
  }
});

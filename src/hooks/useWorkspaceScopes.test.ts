import assert from 'node:assert/strict';
import test from 'node:test';
import { stable } from '../lib/stable';
import { startWorkspaceDiscovery, type WorkspaceDiscoverySnapshot } from './useWorkspaceScopes';
import type { GitWorktree } from '../types/vcs';

const worktree = (path: string, isMain = true): GitWorktree => ({
  path,
  head: null,
  branch: 'main',
  bare: false,
  detached: false,
  locked: false,
  isMain,
  isCurrent: false,
});

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test('an incomplete discovery keeps retrying without depending on snapshot churn', async () => {
  // Regression: the retry loop used to be re-armed by the effect re-running on
  // a NEW snapshot identity every pass, so every 5s retry re-rendered the app,
  // re-fired sessions.list, and re-grouped the sidebar even when nothing
  // changed (runaway idle CPU). The loop must reschedule itself even when the
  // published payload is identical to the previous one.
  let loads = 0;
  const published: WorkspaceDiscoverySnapshot[] = [];
  const cancel = startWorkspaceDiscovery({
    workspaceCwds: ['/repo/app', '/plain/folder'],
    key: JSON.stringify(['/repo/app', '/plain/folder']),
    startDelayMs: null,
    retryDelayMs: 1,
    loadWorktrees: (cwd) => {
      loads += 1;
      // The plain folder never reports worktrees, so discovery stays
      // incomplete forever.
      return Promise.resolve(cwd === '/repo/app' ? [worktree('/repo/app')] : []);
    },
    publish: (snapshot) => published.push(snapshot),
    onCanonicalCwds: () => assert.fail('canonical cwds did not change'),
  });
  try {
    await waitFor(() => published.length >= 3);
  } finally {
    cancel();
  }
  assert.ok(loads >= 6, `expected repeated discovery, saw ${String(loads)} loads`);
  // Identical retry payloads must be deep-equal so the hook's stable()
  // publish keeps the previous snapshot identity and nothing re-renders.
  assert.equal(stable(published[0], published[1]), published[0]);
  assert.equal(published[0].complete, false);
});

test('a complete discovery publishes once and stops', async () => {
  const published: WorkspaceDiscoverySnapshot[] = [];
  const cancel = startWorkspaceDiscovery({
    workspaceCwds: ['/repo/app'],
    key: JSON.stringify(['/repo/app']),
    startDelayMs: null,
    retryDelayMs: 1,
    loadWorktrees: () => Promise.resolve([worktree('/repo/app')]),
    publish: (snapshot) => published.push(snapshot),
    onCanonicalCwds: () => assert.fail('canonical cwds did not change'),
  });
  try {
    await waitFor(() => published.length === 1);
    // Give a would-be retry room to fire before asserting it never does.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    cancel();
  }
  assert.equal(published.length, 1);
  assert.equal(published[0].complete, true);
  assert.deepEqual(published[0].scopes, [{ cwd: '/repo/app', executionCwds: ['/repo/app'] }]);
});

test('a canonical key change hands off instead of retrying under the stale key', async () => {
  const canonical: string[][] = [];
  let loads = 0;
  const cancel = startWorkspaceDiscovery({
    workspaceCwds: ['/repo/app/.worktrees/feature', '/plain/folder'],
    key: JSON.stringify(['/repo/app/.worktrees/feature', '/plain/folder']),
    startDelayMs: null,
    retryDelayMs: 1,
    // Incomplete AND non-canonical: the linked worktree resolves to the main
    // repository while the plain folder reports nothing, so the loop must hand
    // off via onCanonicalCwds rather than keep polling under the stale key.
    loadWorktrees: (cwd) => {
      loads += 1;
      return Promise.resolve(cwd === '/repo/app/.worktrees/feature' ? [worktree('/repo/app')] : []);
    },
    publish: () => {},
    onCanonicalCwds: (cwds) => canonical.push(cwds),
  });
  try {
    await waitFor(() => canonical.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    cancel();
  }
  // One discovery pass (both workspaces loaded once), then the hand-off; no
  // retry under the stale key.
  assert.equal(loads, 2);
  assert.deepEqual(canonical, [['/repo/app', '/plain/folder']]);
});

test('cancel stops the loop and drops the in-flight result', async () => {
  let release: (() => void) | undefined;
  const published: WorkspaceDiscoverySnapshot[] = [];
  const cancel = startWorkspaceDiscovery({
    workspaceCwds: ['/repo/app'],
    key: JSON.stringify(['/repo/app']),
    startDelayMs: null,
    retryDelayMs: 1,
    loadWorktrees: () =>
      new Promise((resolve) => {
        release = () => resolve([worktree('/repo/app')]);
      }),
    publish: (snapshot) => published.push(snapshot),
    onCanonicalCwds: () => {},
  });
  await waitFor(() => release !== undefined);
  cancel();
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(published.length, 0);
});

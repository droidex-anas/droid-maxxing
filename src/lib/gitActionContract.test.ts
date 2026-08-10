import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutGitBranch, gitFetch } from './git';
import { prepareChatWorkingDirectory, resolveMainCheckout } from './chatWorkspace';
import { createPullRequest, detectPullRequest, postPrComment } from './github';

// These wrappers promise one error contract: IPC-level rejections surface as
// structured failures, never as rejected promises. Simulate the desktop bridge
// by installing a fake window.droidControl for the duration of each test.
type FakeApi = Record<string, (...args: unknown[]) => Promise<unknown>>;
const g = globalThis as { window?: { droidControl?: FakeApi } };

function withBridge(api: FakeApi) {
  g.window = { droidControl: api };
}

afterEach(() => {
  delete g.window;
});

test('action wrappers fail with not_desktop outside the desktop shell', async () => {
  assert.deepEqual(await checkoutGitBranch('/repo', { ref: 'main' }), {
    ok: false,
    reason: 'not_desktop',
  });
});

test('gitFetch reports no_dir before the desktop check', async () => {
  assert.deepEqual(await gitFetch(''), { ok: false, reason: 'no_dir' });
});

test('action wrappers convert IPC rejections into failed results', async () => {
  withBridge({ gitCheckout: () => Promise.reject(new Error('bridge down')) });
  assert.deepEqual(await checkoutGitBranch('/repo', { ref: 'main' }), {
    ok: false,
    reason: 'ipc_error',
  });
});

test('action wrappers pass successful results through untouched', async () => {
  const result = { ok: true };
  withBridge({ gitCheckout: () => Promise.resolve(result) });
  assert.equal(await checkoutGitBranch('/repo', { ref: 'main' }), result);
});

test('chat worktrees are created from the Git-owned main repository', async () => {
  let createArgs: unknown[] = [];
  withBridge({
    gitEnvironment: () =>
      Promise.resolve({ isRepo: true, repoRoot: '/repo/.worktrees/current', branch: 'feature' }),
    gitWorktrees: () =>
      Promise.resolve([
        { path: '/repo', isMain: true, bare: false },
        { path: '/repo/.worktrees/current', isMain: false, bare: false },
      ]),
    gitCreateWorktree: (...args) => {
      createArgs = args;
      return Promise.resolve({ ok: true, path: '/repo/.worktrees/chat-c-1' });
    },
  });

  const result = await prepareChatWorkingDirectory('/repo/.worktrees/current', {
    executionMode: 'worktree',
    base: 'origin/main',
    name: 'chat-c-1',
  });

  assert.deepEqual(createArgs, [
    '/repo',
    { detached: true, base: 'origin/main', name: 'chat-c-1' },
  ]);
  assert.deepEqual(result, { ok: true, path: '/repo/.worktrees/chat-c-1' });
});

test('main checkout selection waits when a linked checkout has no worktree snapshot', () => {
  assert.equal(
    resolveMainCheckout(
      {
        isRepo: true,
        repoRoot: '/repo/.worktrees/current',
        isLinkedWorktree: true,
      },
      [],
    ),
    null,
  );
  assert.deepEqual(
    resolveMainCheckout({ isRepo: true, repoRoot: '/repo', isLinkedWorktree: false }, [
      { path: '/repo', branch: 'main', isMain: true, bare: false },
    ]),
    { path: '/repo', branch: 'main' },
  );
});

test('local chat preparation never invokes Git', async () => {
  let gitCalls = 0;
  const unexpectedGitCall = () => {
    gitCalls += 1;
    return Promise.reject(new Error('local preparation invoked Git'));
  };
  withBridge({
    gitEnvironment: unexpectedGitCall,
    gitWorktrees: unexpectedGitCall,
    gitCreateWorktree: unexpectedGitCall,
  });
  assert.deepEqual(
    await prepareChatWorkingDirectory('/repo', {
      executionMode: 'local',
      name: 'chat-c-1',
    }),
    { ok: true, path: '/repo' },
  );
  assert.equal(gitCalls, 0);
});

test('linked checkout preparation waits for the main worktree discovery', async () => {
  let createCalls = 0;
  withBridge({
    gitEnvironment: () =>
      Promise.resolve({
        isRepo: true,
        repoRoot: '/repo/.worktrees/current',
        isLinkedWorktree: true,
        branch: 'feature',
      }),
    gitWorktrees: () => Promise.resolve([]),
    gitCreateWorktree: () => {
      createCalls += 1;
      return Promise.resolve({ ok: true, path: '/wrong/chat' });
    },
  });

  const result = await prepareChatWorkingDirectory('/repo/.worktrees/current', {
    executionMode: 'worktree',
    name: 'chat-c-1',
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree_discovery_pending',
    message: 'The repository worktrees are still loading. Try again.',
  });
  assert.equal(createCalls, 0);
});

test('folderless chat preparation preserves the successful empty directory', async () => {
  const result = await prepareChatWorkingDirectory('', {
    executionMode: 'local',
    name: 'chat-c-1',
  });

  assert.deepEqual(result, { ok: true, path: '' });
});

test('chat worktree preparation rejects a successful response without a path', async () => {
  withBridge({
    gitEnvironment: () => Promise.resolve({ isRepo: true, repoRoot: '/repo', branch: 'main' }),
    gitWorktrees: () => Promise.resolve([{ path: '/repo', isMain: true, bare: false }]),
    gitCreateWorktree: () => Promise.resolve({ ok: true }),
  });

  const result = await prepareChatWorkingDirectory('/repo', {
    executionMode: 'worktree',
    name: 'chat-c-1',
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree_create_failed',
    message: 'Git did not return the new worktree path.',
  });
});

test('detectPullRequest treats non-desktop and missing dir as an authoritative empty answer', async () => {
  // { ok: true, pr: null } may clear a previously shown PR ...
  assert.deepEqual(await detectPullRequest('/repo'), { ok: true, pr: null });
  withBridge({ githubDetectPr: () => Promise.resolve({ ok: true, pr: null }) });
  assert.deepEqual(await detectPullRequest(''), { ok: true, pr: null });
});

test('detectPullRequest reports IPC failure as non-authoritative', async () => {
  // ... while { ok: false } must keep the last-known PR in usePullRequest.
  withBridge({ githubDetectPr: () => Promise.reject(new Error('bridge down')) });
  assert.deepEqual(await detectPullRequest('/repo'), { ok: false, pr: null });
});

test('detectPullRequest passes the bridge answer through untouched', async () => {
  const answer = { ok: true, pr: { number: 12, title: 'x' } };
  withBridge({ githubDetectPr: () => Promise.resolve(answer) });
  assert.equal(await detectPullRequest('/repo', 'feature/foo'), answer);
});

test('createPullRequest and postPrComment convert IPC rejections into failed results', async () => {
  withBridge({
    githubCreatePr: () => Promise.reject(new Error('bridge down')),
    githubPostComment: () => Promise.reject(new Error('bridge down')),
  });
  assert.deepEqual(await createPullRequest('/repo', { title: 't' }), {
    ok: false,
    reason: 'error',
  });
  assert.deepEqual(await postPrComment('/repo', 12, 'hello'), { ok: false, reason: 'error' });
});

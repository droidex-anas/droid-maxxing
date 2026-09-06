import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatPullRequestDiscovery, type ChatPrTarget } from './chatPullRequests';
import type { PullRequest } from '../types/vcs';

function discoverChatPullRequests(
  getTargets: () => readonly ChatPrTarget[],
  onDetected: Parameters<ChatPullRequestDiscovery['discover']>[1],
  isCancelled: () => boolean,
  api: ConstructorParameters<typeof ChatPullRequestDiscovery>[0],
  signal?: AbortSignal,
) {
  return new ChatPullRequestDiscovery(api).discover(getTargets, onDetected, isCancelled, signal);
}

const pr: PullRequest = {
  number: 42,
  url: 'https://github.com/team/repo/pull/42',
  title: 'Sidebar',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'sidebar',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  createdAt: null,
  updatedAt: null,
  author: null,
  reviewRequests: [],
  reviews: [],
};

test('automatic discovery deduplicates worktrees and ignores moved chats and cancelled results', async () => {
  let targets: ChatPrTarget[] = [
    { appSessionId: 'one', cwd: '/worktree' },
    { appSessionId: 'two', cwd: '/worktree' },
    { appSessionId: 'moved', cwd: '/worktree' },
  ];
  let cancelled = false;
  let calls = 0;
  const linked: string[][] = [];
  const api = {
    getGithubAvailability: async () => ({
      installed: true,
      authenticated: true,
      installMethod: 'manual' as const,
    }),
    getGitEnvironment: async () => ({
      isRepo: true,
      isGitHub: true,
      branch: 'sidebar',
      worktreePath: '/worktree',
    }),
    detectPullRequest: async (cwd: string, branch?: string) => {
      calls++;
      assert.equal(cwd, '/worktree');
      assert.equal(branch, 'sidebar');
      targets = targets.map((target) =>
        target.appSessionId === 'moved' ? { ...target, cwd: '/other' } : target,
      );
      return { ok: true, pr };
    },
  };
  await discoverChatPullRequests(
    () => targets,
    (cwd, ids) => {
      assert.equal(cwd, '/worktree');
      linked.push(ids);
    },
    () => cancelled,
    api,
  );
  assert.equal(calls, 1);
  assert.deepEqual(linked, [['one', 'two']]);
  targets = targets.filter((target) => target.cwd === '/worktree');
  await discoverChatPullRequests(
    () => targets,
    () => assert.fail('cancelled result linked'),
    () => cancelled,
    {
      ...api,
      detectPullRequest: async () => {
        cancelled = true;
        return { ok: true, pr };
      },
    },
  );
});

const available = async () => ({
  installed: true,
  authenticated: true,
  installMethod: 'manual' as const,
});
const environment = async () => ({
  isRepo: true,
  isGitHub: true,
  branch: 'sidebar',
  worktreePath: '/worktree',
});

test('subdirectories share one canonical worktree lookup and retain original cwd targeting', async () => {
  let calls = 0;
  const targets = [
    { appSessionId: 'root', cwd: '/worktree' },
    { appSessionId: 'sub', cwd: '/worktree/src' },
  ];
  const linked: string[] = [];
  await discoverChatPullRequests(
    () => targets,
    (cwd) => linked.push(cwd),
    () => false,
    {
      getGithubAvailability: available,
      getGitEnvironment: environment,
      detectPullRequest: async (cwd) => {
        calls++;
        assert.equal(cwd, '/worktree');
        return { ok: true, pr };
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(linked, ['/worktree', '/worktree/src']);
});

test('timeout blocks further IPC until the original operation settles, then polling recovers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<void>();
  const original = Promise.withResolvers<Awaited<ReturnType<typeof environment>>>();
  const calls: string[] = [];
  let first = true;
  const discovery = new ChatPullRequestDiscovery({
    getGithubAvailability: async () => {
      calls.push('availability');
      return available();
    },
    getGitEnvironment: (cwd) => {
      calls.push(cwd);
      if (first) {
        first = false;
        started.resolve();
        return original.promise;
      }
      return environment();
    },
    detectPullRequest: async () => {
      calls.push('pr');
      return { ok: true, pr };
    },
  });
  const targets = () => [
    { appSessionId: 'one', cwd: '/worktree' },
    { appSessionId: 'two', cwd: '/worktree/sub' },
  ];
  const linked: string[] = [];
  const run = discovery.discover(
    targets,
    (cwd) => {
      linked.push(cwd);
    },
    () => false,
  );
  const timedOut = assert.rejects(run, /timed out/);
  await started.promise;
  t.mock.timers.tick(10_000);
  await timedOut;
  assert.deepEqual(calls, ['availability', '/worktree']);
  await assert.rejects(
    discovery.discover(
      targets,
      () => assert.fail('late link'),
      () => false,
    ),
    /previous lookup/,
  );
  assert.deepEqual(calls, ['availability', '/worktree']);
  original.resolve(await environment());
  await original.promise;
  await discovery.discover(
    targets,
    (cwd) => {
      linked.push(cwd);
    },
    () => false,
  );
  assert.deepEqual(linked, ['/worktree', '/worktree/sub']);
  assert.equal(calls.filter((call) => call === 'pr').length, 1);
});

test('cancellation releases a hung availability lookup without linking late results', async () => {
  const controller = new AbortController();
  const run = discoverChatPullRequests(
    () => [{ appSessionId: 'one', cwd: '/worktree' }],
    () => assert.fail('linked cancelled discovery'),
    () => controller.signal.aborted,
    {
      getGithubAvailability: () => new Promise<never>(() => {}),
      getGitEnvironment: environment,
      detectPullRequest: async () => ({ ok: true, pr }),
    },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(run, /cancelled/);
});

test('aborting a scan does not release its underlying operation for a replacement scan', async () => {
  const started = Promise.withResolvers<void>();
  const original = Promise.withResolvers<Awaited<ReturnType<typeof available>>>();
  let calls = 0;
  const discovery = new ChatPullRequestDiscovery({
    getGithubAvailability: () => {
      calls++;
      started.resolve();
      return original.promise;
    },
    getGitEnvironment: environment,
    detectPullRequest: async () => ({ ok: true, pr }),
  });
  const targets = () => [{ appSessionId: 'one', cwd: '/worktree' }];
  const controller = new AbortController();
  const run = discovery.discover(
    targets,
    () => assert.fail('cancelled link'),
    () => controller.signal.aborted,
    controller.signal,
  );
  const cancelled = assert.rejects(run, /cancelled/);
  await started.promise;
  controller.abort();
  await cancelled;
  await assert.rejects(
    discovery.discover(
      targets,
      () => assert.fail('overlap'),
      () => false,
    ),
    /previous lookup/,
  );
  assert.equal(calls, 1);
  original.resolve(await available());
  await original.promise;
  const links: string[] = [];
  await discovery.discover(
    targets,
    (cwd) => {
      links.push(cwd);
    },
    () => false,
  );
  assert.deepEqual(links, ['/worktree']);
});

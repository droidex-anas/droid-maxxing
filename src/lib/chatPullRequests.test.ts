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

test('a timed-out worktree does not abort later worktrees or throw on the next poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => undefined);
  const started = Promise.withResolvers<void>();
  const hung = Promise.withResolvers<Awaited<ReturnType<typeof environment>>>();
  const calls: string[] = [];
  const discovery = new ChatPullRequestDiscovery({
    getGithubAvailability: async () => {
      calls.push('availability');
      return available();
    },
    getGitEnvironment: (cwd) => {
      calls.push(cwd);
      if (cwd === '/hung') {
        started.resolve();
        return hung.promise;
      }
      return Promise.resolve({
        isRepo: true,
        isGitHub: true,
        branch: 'sidebar',
        worktreePath: cwd,
      });
    },
    detectPullRequest: async (cwd) => {
      calls.push(`pr:${cwd}`);
      return { ok: true, pr };
    },
  });
  const targets = () => [
    { appSessionId: 'one', cwd: '/hung' },
    { appSessionId: 'two', cwd: '/ready' },
  ];
  const linked: string[] = [];
  const run = discovery.discover(
    targets,
    (cwd) => {
      linked.push(cwd);
    },
    () => false,
  );
  await started.promise;
  t.mock.timers.tick(10_000);
  await run;
  assert.deepEqual(linked, ['/ready']);
  assert.equal(calls.filter((call) => call === 'pr:/ready').length, 1);
  await discovery.discover(
    targets,
    () => assert.fail('late link'),
    () => false,
  );
  assert.deepEqual(
    calls.filter((call) => call === 'availability'),
    ['availability'],
  );
  hung.resolve({
    isRepo: true,
    isGitHub: true,
    branch: 'sidebar',
    worktreePath: '/hung',
  });
  await hung.promise;
  await discovery.discover(
    targets,
    (cwd) => {
      linked.push(cwd);
    },
    () => false,
  );
  assert.deepEqual(linked, ['/ready', '/hung', '/ready']);
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
  await discovery.discover(
    targets,
    () => assert.fail('overlap'),
    () => false,
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

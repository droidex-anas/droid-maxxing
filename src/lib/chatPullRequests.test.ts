import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverChatPullRequests, type ChatPrTarget } from './chatPullRequests';
import type { PullRequest } from '../types/vcs';

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

test('a hung lookup times out and the next worktree still discovers links', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const linked: string[] = [];
  const run = discoverChatPullRequests(
    () => [
      { appSessionId: 'hung', cwd: '/hung' },
      { appSessionId: 'good', cwd: '/worktree' },
    ],
    (cwd) => linked.push(cwd),
    () => false,
    {
      getGithubAvailability: available,
      getGitEnvironment: async (cwd) => {
        if (cwd === '/hung') {
          started();
          return new Promise<never>(() => {});
        }
        return environment();
      },
      detectPullRequest: async () => ({ ok: true, pr }),
    },
  );
  await waiting;
  t.mock.timers.tick(10_000);
  await run;
  assert.deepEqual(linked, ['/worktree']);
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

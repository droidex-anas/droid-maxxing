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
    getGitEnvironment: async () => ({ isRepo: true, isGitHub: true, branch: 'sidebar' }),
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

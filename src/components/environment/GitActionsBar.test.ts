import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GitActionsBar } from './GitActionsBar.js';
import { canRenderPrSheet, reconcileGitActionSheet } from '../../lib/gitActionVisibility.js';
import type { GitEnvironment, PullRequest } from '../../types/vcs.js';

const env: GitEnvironment = {
  isRepo: true,
  isGitHub: true,
  branch: 'feature/setup-card',
  detached: false,
  ahead: 0,
};

const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  title: 'Fix the thing',
  state: 'OPEN',
  url: 'https://example.com/pr/7',
  isDraft: false,
  headRefName: 'fix',
  baseRefName: 'main',
  mergeable: null,
  reviewDecision: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  ...overrides,
});

function render(githubReady: boolean, ahead = 0): string {
  return renderToStaticMarkup(
    createElement(GitActionsBar, {
      cwd: '/repo',
      env: { ...env, ahead },
      branches: null,
      isGitHub: true,
      githubReady,
      hasPr: false,
      pr: null,
      onOpenPr: () => undefined,
      onChanged: () => undefined,
    }),
  );
}

test('local git actions remain while the PR row waits for GitHub setup', () => {
  const html = render(false);

  assert.match(html, />Commit or push</);
  assert.doesNotMatch(html, />Create pull request</);
});

test('Create pull request returns when GitHub setup is ready', () => {
  assert.match(render(true), />Create pull request</);
});

test('a detected PR swaps into the create slot instead of adding a row', () => {
  const html = renderToStaticMarkup(
    createElement(GitActionsBar, {
      cwd: '/repo',
      env,
      branches: null,
      isGitHub: true,
      githubReady: true,
      hasPr: true,
      pr: pr(),
      onOpenPr: () => undefined,
      onChanged: () => undefined,
    }),
  );
  // The PR row replaces the create action in place, so the panel's height
  // does not change when detection resolves.
  assert.match(html, />#7 Fix the thing</);
  assert.doesNotMatch(html, />Create pull request</);
});

test('a merged or closed PR leaves the create action available', () => {
  const html = renderToStaticMarkup(
    createElement(GitActionsBar, {
      cwd: '/repo',
      env,
      branches: null,
      isGitHub: true,
      githubReady: true,
      // prKind of a merged PR is not open/draft, so the section reports no
      // current PR while the detection payload is still around.
      hasPr: false,
      pr: pr({ number: 212, title: 'Tool activity UI', state: 'MERGED' }),
      onOpenPr: () => undefined,
      onChanged: () => undefined,
    }),
  );
  assert.match(html, />Create pull request</);
  assert.doesNotMatch(html, /#212/);
});

test('the push pill only appears while ahead of upstream', () => {
  assert.doesNotMatch(render(true, 0), /Push \d+ commits/);
  assert.match(render(true, 2), /title="Push 2 commits"/);
  assert.match(render(true, 1), /title="Push 1 commit"/);
});

test('an open PR sheet closes when GitHub readiness is lost', () => {
  assert.equal(canRenderPrSheet('pr', true, true, false, false), true);
  assert.equal(canRenderPrSheet('pr', true, false, false, false), false);
  assert.equal(canRenderPrSheet('pr', false, true, false, false), false);
  assert.equal(canRenderPrSheet('pr', true, true, true, false), false);
  assert.equal(reconcileGitActionSheet('pr', true, false, false, false), 'none');
  assert.equal(reconcileGitActionSheet('commit', true, false, false, false), 'commit');
});

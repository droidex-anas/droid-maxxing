import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrCheck, PrComment } from '../../../types/vcs';
import { initialPrDetailState, reducePrDetail } from './prDetailState';

const sampleCheck: PrCheck = {
  name: 'ci',
  workflow: null,
  bucket: 'pass',
  state: 'SUCCESS',
  description: '',
  link: null,
  startedAt: null,
  completedAt: null,
};

const sampleComment: PrComment = {
  id: 'c1',
  kind: 'comment',
  author: 'ana',
  body: 'Looks good',
  createdAt: null,
  url: null,
  state: null,
  reactions: [],
};

test('number change drops body, checks, comments, and cached diff', () => {
  const loaded = reducePrDetail(initialPrDetailState, {
    type: 'meta-success',
    generation: 0,
    body: 'Hi',
    checks: [],
    comments: [],
    checksError: null,
    commentsError: null,
  });
  const next = reducePrDetail(loaded, { type: 'bind', cwd: '/repo', number: 2 });
  assert.equal(next.body, '');
  assert.equal(next.diff, '');
  assert.equal(next.loaded, false);
});

test('failed section keeps prior rows; diff success is ignored until requested', () => {
  const bound = reducePrDetail(initialPrDetailState, { type: 'bind', cwd: '/repo', number: 1 });
  const failed = reducePrDetail(bound, {
    type: 'meta-failure',
    generation: bound.generation,
    message: 'down',
  });
  assert.equal(failed.loaded, true);
  assert.equal(failed.metaError, 'down');
  const unsolicited = reducePrDetail(failed, {
    type: 'diff-success',
    generation: bound.generation,
    diff: 'x',
  });
  assert.equal(unsolicited.diff, '');
  const asked = reducePrDetail(failed, { type: 'diff-request', generation: bound.generation });
  const got = reducePrDetail(asked, {
    type: 'diff-success',
    generation: bound.generation,
    diff: 'x',
  });
  assert.equal(got.diff, 'x');
});

test('all-fail first load via meta-success stores section errors on empty rows', () => {
  const bound = reducePrDetail(initialPrDetailState, { type: 'bind', cwd: '/repo', number: 1 });
  const failed = reducePrDetail(bound, {
    type: 'meta-success',
    generation: bound.generation,
    body: '',
    checks: [],
    comments: [],
    checksError: 'Could not load PR checks',
    commentsError: 'Could not load PR comments',
    metaError: 'Could not load pull request',
  });
  assert.equal(failed.loaded, true);
  assert.equal(failed.checks.length, 0);
  assert.equal(failed.comments.length, 0);
  assert.equal(failed.checksError, 'Could not load PR checks');
  assert.equal(failed.commentsError, 'Could not load PR comments');
  assert.equal(failed.metaError, 'Could not load pull request');
});

test('meta-success keeps last good rows and records per-section errors', () => {
  const bound = reducePrDetail(initialPrDetailState, { type: 'bind', cwd: '/repo', number: 1 });
  const loaded = reducePrDetail(bound, {
    type: 'meta-success',
    generation: bound.generation,
    body: 'Hi',
    checks: [sampleCheck],
    comments: [sampleComment],
    checksError: null,
    commentsError: null,
    metaError: null,
  });
  const failed = reducePrDetail(loaded, {
    type: 'meta-success',
    generation: bound.generation,
    body: loaded.body,
    checks: loaded.checks,
    comments: loaded.comments,
    checksError: 'Could not load PR checks',
    commentsError: 'Could not load PR comments',
    metaError: 'Could not load pull request',
  });
  assert.equal(failed.body, 'Hi');
  assert.equal(failed.checks, loaded.checks);
  assert.equal(failed.comments, loaded.comments);
  assert.equal(failed.checksError, 'Could not load PR checks');
  assert.equal(failed.commentsError, 'Could not load PR comments');
  assert.equal(failed.metaError, 'Could not load pull request');
});

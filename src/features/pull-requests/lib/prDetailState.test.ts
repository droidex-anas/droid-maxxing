import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPrDetailState, reducePrDetail } from './prDetailState';

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

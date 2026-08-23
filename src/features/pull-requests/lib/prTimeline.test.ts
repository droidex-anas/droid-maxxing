import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrComment, PrCommit } from '../../../types/vcs';
import { buildPrTimeline, shortSha } from './prTimeline';

const comment = (id: string, createdAt: string | null): PrComment => ({
  id,
  kind: 'comment',
  author: 'ana',
  body: id,
  createdAt,
  url: null,
  state: null,
  reactions: [],
});

const commit = (oid: string, committedDate: string | null): PrCommit => ({
  oid,
  headline: oid,
  committedDate,
  author: 'ana',
});

test('commits and comments interleave in chronological order', () => {
  const items = buildPrTimeline(
    [comment('first', '2026-08-04T10:00:00Z'), comment('last', '2026-08-04T12:00:00Z')],
    [commit('aaa1111', '2026-08-04T11:00:00Z')],
  );
  assert.deepEqual(
    items.map((item) => (item.kind === 'comment' ? item.comment.id : item.commits.length)),
    ['first', 1, 'last'],
  );
});

test('a run of commits between comments folds into one group', () => {
  const items = buildPrTimeline(
    [comment('opening', '2026-08-04T10:00:00Z')],
    [
      commit('aaa1111', '2026-08-04T10:30:00Z'),
      commit('bbb2222', '2026-08-04T10:40:00Z'),
      commit('ccc3333', '2026-08-04T10:50:00Z'),
    ],
  );
  assert.equal(items.length, 2);
  assert.equal(items[1]?.kind, 'commits');
  assert.deepEqual(items[1]?.kind === 'commits' ? items[1].commits.map((entry) => entry.oid) : [], [
    'aaa1111',
    'bbb2222',
    'ccc3333',
  ]);
});

test('a comment between two pushes splits the commits into separate groups', () => {
  const items = buildPrTimeline(
    [comment('review', '2026-08-04T11:00:00Z')],
    [commit('aaa1111', '2026-08-04T10:00:00Z'), commit('bbb2222', '2026-08-04T12:00:00Z')],
  );
  assert.deepEqual(
    items.map((item) => item.kind),
    ['commits', 'comment', 'commits'],
  );
});

test('undated entries stay in the timeline instead of being dropped', () => {
  const items = buildPrTimeline([comment('undated', null)], [commit('aaa1111', null)]);
  assert.equal(items.length, 2);
});

test('short shas are the seven-character git prefix', () => {
  assert.equal(shortSha('0123456789abcdef'), '0123456');
  assert.equal(shortSha('abc'), 'abc');
});

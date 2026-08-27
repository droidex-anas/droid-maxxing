import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrBacklogId,
  BACKLOG_ID_MAX,
  BACKLOG_LIMIT,
  prBacklogId,
  sanitizePersistedPrBacklog,
} from './prBacklog';

test('prBacklogId prefers a GitHub pull URL over the local folder', () => {
  assert.equal(
    prBacklogId({
      cwd: '/repos/clinic',
      number: 12,
      url: 'https://github.com/EvilFps/dr-koshley-skin-clinic/pull/12',
    }),
    'evilfps/dr-koshley-skin-clinic#12',
  );
});

test('prBacklogId falls back to the comparable folder and number', () => {
  assert.equal(prBacklogId({ cwd: 'C:\\Repos\\App', number: 4 }), 'c:/repos/app#4');
});

test('sanitizePersistedPrBacklog keeps unique trimmed ids', () => {
  assert.deepEqual(sanitizePersistedPrBacklog([' a/b#1 ', 'a/b#1', 12, '', 'c/d#2']), [
    'a/b#1',
    'c/d#2',
  ]);
  assert.deepEqual(sanitizePersistedPrBacklog(null), []);
});

test('a long workspace path stays a stable bounded id', () => {
  const left = `/${'a'.repeat(BACKLOG_ID_MAX)}`;
  const right = `/${'b'.repeat(BACKLOG_ID_MAX)}`;
  const leftId = prBacklogId({ cwd: left, number: 9 });
  assert.ok(leftId.length <= BACKLOG_ID_MAX);
  assert.equal(leftId, prBacklogId({ cwd: left, number: 9 }));
  assert.notEqual(leftId, prBacklogId({ cwd: right, number: 9 }));
  assert.deepEqual(sanitizePersistedPrBacklog([leftId]), [leftId]);
});

test('addPrBacklogId rejects blank, oversized, duplicate, and full lists', () => {
  assert.equal(addPrBacklogId([], '  '), null);
  assert.equal(addPrBacklogId([], 'x'.repeat(BACKLOG_ID_MAX + 1)), null);
  assert.equal(addPrBacklogId(['acme/app#1'], 'acme/app#1'), null);
  assert.equal(
    addPrBacklogId(
      Array.from({ length: BACKLOG_LIMIT }, (_, i) => `a#${i}`),
      'a#new',
    ),
    null,
  );
  assert.deepEqual(addPrBacklogId(['acme/app#1'], ' acme/app#2 '), ['acme/app#1', 'acme/app#2']);
});

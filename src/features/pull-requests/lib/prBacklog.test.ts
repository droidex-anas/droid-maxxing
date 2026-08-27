import assert from 'node:assert/strict';
import test from 'node:test';

import { prBacklogId, sanitizePersistedPrBacklog } from './prBacklog';

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

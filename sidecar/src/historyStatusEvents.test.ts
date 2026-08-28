import assert from 'node:assert/strict';
import test from 'node:test';

import { serverEventForHistoryStatus } from './historyStatusEvents.js';

test('healthy persistence maps to a recovered event rather than a toast-shaped error', () => {
  assert.deepEqual(serverEventForHistoryStatus({ state: 'healthy' }), {
    type: 'history.persistenceRecovered',
  });
});

test('degraded persistence stays recoverable and names the durability failure', () => {
  const event = serverEventForHistoryStatus({ state: 'degraded', message: 'disk full' });
  assert.equal(event.type, 'error');
  if (event.type !== 'error') return;
  assert.equal(event.code, 'history.persistence_degraded');
  assert.equal(event.recoverable, true);
  assert.match(event.message, /disk full/);
  assert.doesNotMatch(event.message, /\d+\s*%/);
  assert.doesNotMatch(event.message, /ETA/i);
});

test('unavailable search names the host failure without claiming results exist', () => {
  const event = serverEventForHistoryStatus({
    state: 'search_unavailable',
    message: 'FTS5 missing',
  });
  assert.equal(event.type, 'error');
  if (event.type !== 'error') return;
  assert.equal(event.code, 'history.search_unavailable');
  assert.equal(event.recoverable, false);
  assert.match(event.message, /FTS5 missing/);
  assert.doesNotMatch(event.message, /\d+\s*%/);
  assert.doesNotMatch(event.message, /ETA/i);
});

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  applyHistoryServerEvent,
  getHistoryHealth,
  isHistoryStatusError,
  resetHistoryHealthForTests,
  subscribeHistoryHealth,
} from './historyHealth';
import {
  HISTORY_INDEXING_INCOMPLETE_MESSAGE,
  HISTORY_PERSISTENCE_DEGRADED_MESSAGE,
  HISTORY_SEARCH_UNAVAILABLE_MESSAGE,
} from './historyStatusCopy';

afterEach(() => {
  resetHistoryHealthForTests();
});

test('persistence degradation is sticky until recovery and does not re-emit while set', () => {
  const seen: Array<ReturnType<typeof getHistoryHealth>> = [];
  const stop = subscribeHistoryHealth(() => {
    seen.push(getHistoryHealth());
  });
  applyHistoryServerEvent({
    type: 'error',
    code: 'history.persistence_degraded',
    message: 'worker failed',
    recoverable: true,
  });
  applyHistoryServerEvent({
    type: 'error',
    code: 'history.persistence_degraded',
    message: 'worker failed again',
    recoverable: true,
  });
  assert.deepEqual(getHistoryHealth(), { persistence: 'degraded', search: 'ok' });
  assert.equal(seen.length, 1);
  applyHistoryServerEvent({ type: 'history.persistenceRecovered' });
  applyHistoryServerEvent({ type: 'history.persistenceRecovered' });
  assert.deepEqual(getHistoryHealth(), { persistence: 'ok', search: 'ok' });
  assert.equal(seen.length, 2);
  stop();
});

test('search unavailability is sticky until a successful search reply', () => {
  applyHistoryServerEvent({
    type: 'error',
    code: 'history.search_unavailable',
    message: 'FTS5 missing',
    recoverable: false,
  });
  assert.deepEqual(getHistoryHealth(), { persistence: 'ok', search: 'unavailable' });
  applyHistoryServerEvent({
    type: 'sessions.searchResults',
    requestId: 'req-1',
    results: [],
    indexingIncomplete: false,
  });
  assert.deepEqual(getHistoryHealth(), { persistence: 'ok', search: 'ok' });
});

test('history status errors are identified without treating other errors as status', () => {
  assert.equal(
    isHistoryStatusError({
      type: 'error',
      code: 'history.persistence_degraded',
      message: 'degraded',
    }),
    true,
  );
  assert.equal(
    isHistoryStatusError({
      type: 'error',
      code: 'history.search_unavailable',
      message: 'unavailable',
    }),
    true,
  );
  assert.equal(
    isHistoryStatusError({
      type: 'error',
      code: 'history.unflushed_work',
      message: 'unflushed',
    }),
    false,
  );
});

test('history status copy never fabricates progress', () => {
  for (const message of [
    HISTORY_PERSISTENCE_DEGRADED_MESSAGE,
    HISTORY_SEARCH_UNAVAILABLE_MESSAGE,
    HISTORY_INDEXING_INCOMPLETE_MESSAGE,
  ]) {
    assert.doesNotMatch(message, /\d+\s*%/);
    assert.doesNotMatch(message, /ETA/i);
    assert.doesNotMatch(message, /progress/i);
  }
});

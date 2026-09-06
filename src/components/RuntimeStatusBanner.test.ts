import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import RuntimeStatusBanner from './RuntimeStatusBanner';
import { applyHistoryServerEvent, resetHistoryHealthForTests } from '../lib/historyHealth';
import { HISTORY_PERSISTENCE_DEGRADED_MESSAGE } from '../lib/historyStatusCopy';
import { applySidecarStatus, setTransportHealth } from '../lib/runtimeHealth';

afterEach(() => {
  resetHistoryHealthForTests();
  applySidecarStatus({
    lifecycle: 'healthy',
    processAlive: true,
    bridgeResponsive: true,
    lastHeartbeatAt: 1,
    restartCount: 0,
  });
  setTransportHealth('connected');
});

test('persistence degradation renders a durable banner that clears on recovery', () => {
  applySidecarStatus({
    lifecycle: 'healthy',
    processAlive: true,
    bridgeResponsive: true,
    lastHeartbeatAt: 1,
    restartCount: 0,
  });
  setTransportHealth('connected');
  applyHistoryServerEvent({
    type: 'error',
    code: 'history.persistence_degraded',
    message: 'worker failed',
    recoverable: true,
  });

  const degraded = renderToStaticMarkup(createElement(RuntimeStatusBanner));
  assert.ok(degraded.includes('data-testid="history-persistence-banner"'));
  assert.ok(degraded.includes(HISTORY_PERSISTENCE_DEGRADED_MESSAGE));
  assert.doesNotMatch(degraded, /\d+\s*%/);
  assert.doesNotMatch(degraded, /ETA/i);

  applyHistoryServerEvent({ type: 'history.persistenceRecovered' });
  assert.equal(renderToStaticMarkup(createElement(RuntimeStatusBanner)), '');
});

test('search unavailability does not open a global banner', () => {
  applyHistoryServerEvent({
    type: 'error',
    code: 'history.search_unavailable',
    message: 'FTS5 missing',
    recoverable: false,
  });
  assert.equal(renderToStaticMarkup(createElement(RuntimeStatusBanner)), '');
});

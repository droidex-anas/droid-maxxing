import assert from 'node:assert/strict';
import test from 'node:test';

import { GrokTurnWatchdog, ManualGrokTimer } from './grokWatchdog.js';

test('watchdog does not stall before the first ACP activity', () => {
  const timer = new ManualGrokTimer();
  const stalled: string[] = [];
  const watchdog = new GrokTurnWatchdog({
    timer,
    inactivityMs: 100,
    activeToolInactivityMs: 300,
    onStall: (turnId) => stalled.push(turnId),
  });
  watchdog.start('turn-1');
  timer.advance(1_000);
  assert.deepEqual(stalled, []);
});

test('watchdog uses injected time and extends while a tool is active', () => {
  const timer = new ManualGrokTimer();
  const stalled: string[] = [];
  const watchdog = new GrokTurnWatchdog({
    timer,
    inactivityMs: 100,
    activeToolInactivityMs: 300,
    onStall: (turnId) => stalled.push(turnId),
  });
  watchdog.start('turn-1');
  watchdog.recordActivity();
  timer.advance(99);
  assert.deepEqual(stalled, []);
  watchdog.setToolActive('tool-1', true);
  watchdog.recordActivity();
  timer.advance(200);
  assert.deepEqual(stalled, []);
  timer.advance(100);
  assert.deepEqual(stalled, ['turn-1']);
});

test('watchdog clamps waits to the shutdown remaining budget', () => {
  const timer = new ManualGrokTimer();
  const stalled: string[] = [];
  let remaining = 40;
  const watchdog = new GrokTurnWatchdog({
    timer,
    inactivityMs: 10_000,
    remainingMs: () => remaining,
    onStall: (turnId) => stalled.push(turnId),
  });
  watchdog.start('turn-1');
  watchdog.recordActivity();
  remaining = 40;
  timer.advance(40);
  assert.deepEqual(stalled, ['turn-1']);
});

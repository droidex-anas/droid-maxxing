import assert from 'node:assert/strict';
import test from 'node:test';
import { createDialogFocusLifecycle } from './dialogFocus';

test('dialog focus lifecycle restores the opener only once', () => {
  const events: string[] = [];
  const opener = { focus: () => events.push('opener') };
  const lifecycle = createDialogFocusLifecycle(opener);

  lifecycle.restore();
  lifecycle.restore();

  assert.deepEqual(events, ['opener']);
});

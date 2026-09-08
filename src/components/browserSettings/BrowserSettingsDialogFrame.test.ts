import assert from 'node:assert/strict';
import test from 'node:test';

test('dialog focus lifecycle restores the opener only once', async () => {
  const module = await import('./dialogFocus');
  const createDialogFocusLifecycle = Reflect.get(module, 'createDialogFocusLifecycle');
  assert.equal(typeof createDialogFocusLifecycle, 'function');
  const events: string[] = [];
  const opener = { focus: () => events.push('opener') };
  const lifecycle = createDialogFocusLifecycle(opener);

  lifecycle.restore();
  lifecycle.restore();

  assert.deepEqual(events, ['opener']);
});

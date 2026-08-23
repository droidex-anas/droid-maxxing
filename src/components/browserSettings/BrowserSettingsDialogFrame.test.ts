import assert from 'node:assert/strict';
import test from 'node:test';

test('dialog focus lifecycle captures and restores the opener only once', async () => {
  const module = await import('./dialogFocus');
  const createDialogFocusLifecycle = Reflect.get(module, 'createDialogFocusLifecycle');
  assert.equal(typeof createDialogFocusLifecycle, 'function');
  const events: string[] = [];
  const opener = { focus: () => events.push('opener') };
  const initial = { focus: () => events.push('initial') };
  const lifecycle = createDialogFocusLifecycle(opener);

  lifecycle.focusInitial(initial);
  lifecycle.focusInitial(initial);
  lifecycle.restore();
  lifecycle.restore();

  assert.deepEqual(events, ['initial', 'opener']);
});

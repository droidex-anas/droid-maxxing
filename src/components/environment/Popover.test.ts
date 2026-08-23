import assert from 'node:assert/strict';
import test from 'node:test';

test('anchor-width popovers escape a clipping card while staying inside the viewport', async () => {
  const module = await import('./popoverPosition');
  const calculatePopoverPosition = Reflect.get(module, 'calculatePopoverPosition');
  assert.equal(typeof calculatePopoverPosition, 'function');
  assert.deepEqual(
    calculatePopoverPosition({
      anchor: { top: 520, right: 780, bottom: 556, left: 620, width: 160 },
      viewport: { width: 800, height: 600 },
      width: 'anchor',
      align: 'right',
    }),
    {
      bottom: 84,
      left: 620,
      width: 160,
      maxHeight: 508,
    },
  );
});

test('fixed-width popovers clamp to the viewport edge', async () => {
  const module = await import('./popoverPosition');
  const calculatePopoverPosition = Reflect.get(module, 'calculatePopoverPosition');
  assert.equal(typeof calculatePopoverPosition, 'function');
  assert.deepEqual(
    calculatePopoverPosition({
      anchor: { top: 80, right: 798, bottom: 116, left: 760, width: 38 },
      viewport: { width: 800, height: 600 },
      width: 288,
      align: 'left',
    }),
    {
      top: 120,
      left: 504,
      width: 288,
      maxHeight: 472,
    },
  );
});

test('popover width shrinks when the viewport is narrower than its requested width', async () => {
  const module = await import('./popoverPosition');
  const calculatePopoverPosition = Reflect.get(module, 'calculatePopoverPosition');
  assert.equal(typeof calculatePopoverPosition, 'function');

  assert.deepEqual(
    calculatePopoverPosition({
      anchor: { top: 40, right: 180, bottom: 76, left: 140, width: 40 },
      viewport: { width: 200, height: 300 },
      width: 288,
      align: 'right',
    }),
    {
      top: 80,
      left: 8,
      width: 184,
      maxHeight: 212,
    },
  );
});

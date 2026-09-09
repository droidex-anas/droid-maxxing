import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePopoverPosition, parseUiScale } from './popoverGeometry';

test('popover geometry clamps wide panels inside a narrow viewport', () => {
  assert.deepEqual(
    calculatePopoverPosition({
      anchor: { left: 250, right: 310, top: 100, bottom: 132 },
      viewportWidth: 320,
      viewportHeight: 480,
      measuredHeight: 300,
      requestedWidth: 390,
      align: 'end',
      gap: 8,
    }),
    {
      left: 10,
      top: 140,
      width: 300,
      maxHeight: 330,
      placement: 'below',
    },
  );
});

test('popover geometry flips above and caps its height when space below is tight', () => {
  assert.deepEqual(
    calculatePopoverPosition({
      anchor: { left: 80, right: 280, top: 390, bottom: 422 },
      viewportWidth: 420,
      viewportHeight: 460,
      measuredHeight: 560,
      requestedWidth: 390,
      align: 'end',
      gap: 8,
      maximumHeight: 560,
    }),
    {
      left: 10,
      top: 10,
      width: 390,
      maxHeight: 372,
      placement: 'above',
    },
  );
});

test('UI scale parsing rejects missing and invalid zoom values', () => {
  assert.equal(parseUiScale('1.25'), 1.25);
  assert.equal(parseUiScale(''), 1);
  assert.equal(parseUiScale('0'), 1);
  assert.equal(parseUiScale('not-a-number'), 1);
});

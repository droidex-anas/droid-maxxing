import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePopoverPosition, parseUiScale, samePopoverPosition } from './popoverGeometry';
import { virtualOptionWindow } from './selectVirtualization';

test('popover placement stays inside the viewport and prefers the roomier side', () => {
  const below = calculatePopoverPosition({
    anchor: { left: 800, right: 940, top: 100, bottom: 132 },
    viewportWidth: 1000,
    viewportHeight: 800,
    measuredHeight: 300,
    requestedWidth: 340,
    align: 'end',
    gap: 8,
  });
  assert.equal(below.placement, 'below');
  assert.ok(below.left >= 10);
  assert.ok(below.left + below.width <= 990);

  const above = calculatePopoverPosition({
    anchor: { left: 800, right: 940, top: 710, bottom: 742 },
    viewportWidth: 1000,
    viewportHeight: 800,
    measuredHeight: 360,
    requestedWidth: 340,
    align: 'end',
    gap: 8,
  });
  assert.equal(above.placement, 'above');
  assert.ok(above.top >= 10);
});

test('identical position measurements do not schedule redundant React updates', () => {
  const position = {
    left: 100,
    top: 200,
    width: 300,
    maxHeight: 320,
    placement: 'below' as const,
  };
  assert.equal(samePopoverPosition(position, { ...position }), true);
  assert.equal(samePopoverPosition(position, { ...position, top: 201 }), false);
});

test('viewport measurements convert into the CSS pixels of the zoomed UI root', () => {
  assert.equal(parseUiScale('1.5'), 1.5);
  assert.equal(parseUiScale('1'), 1);
  assert.equal(parseUiScale(undefined), 1);
  assert.equal(parseUiScale('normal'), 1);
  assert.equal(parseUiScale('0'), 1);

  const scale = parseUiScale('1.5');
  const zoomed = calculatePopoverPosition({
    anchor: { left: 600 / scale, right: 900 / scale, top: 150 / scale, bottom: 200 / scale },
    viewportWidth: 1200 / scale,
    viewportHeight: 900 / scale,
    measuredHeight: 300,
    requestedWidth: 300,
    align: 'end',
    gap: 8,
  });
  // 900 viewport pixels is 600 root pixels, so an end-aligned 300 wide panel
  // starts at 300 in the coordinate space the panel is styled in.
  assert.equal(zoomed.placement, 'below');
  assert.equal(Math.round(zoomed.left), 300);
  assert.equal(Math.round(zoomed.top), Math.round(200 / scale + 8));
  assert.equal(zoomed.width, 300);
});

test('large selectors render only a bounded option window', () => {
  const first = virtualOptionWindow(500, 0);
  const middle = virtualOptionWindow(500, 7_000);
  assert.equal(first.start, 0);
  assert.ok(first.end < 30);
  assert.ok(middle.start > 100);
  assert.ok(middle.end - middle.start < 30);
  assert.equal(middle.totalHeight, 19_000);
});

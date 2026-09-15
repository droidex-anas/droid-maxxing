import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCrop, dragCrop, outputSize, snapCrop } from './geometry';
import { detectSurfaceRegions } from './detection';

test('reverse drags and outside pointer positions normalize into source pixels', () => {
  assert.deepEqual(dragCrop({ x: 100, y: 80 }, { x: 20, y: 10 }, 200, 100), {
    x: 20,
    y: 10,
    width: 80,
    height: 70,
  });
  assert.deepEqual(clampCrop({ x: -4, y: -10, width: 999, height: 999 }, 200, 100), {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
  });
  assert.throws(() => clampCrop({ x: NaN, y: 0, width: 10, height: 10 }, 200, 100));
});
test('near misses snap but unrelated or heavily oversized selections are not silently replaced', () => {
  const panel = { x: 0, y: 0, width: 100, height: 80 };
  const near = { x: 3, y: 4, width: 93, height: 75 };
  assert.equal(snapCrop(near, [panel], 8), panel);
  const broad = { x: 0, y: 0, width: 200, height: 160 };
  assert.equal(snapCrop(broad, [panel], 200), broad);
  assert.equal(snapCrop(near, [], 8), near);
});
test('output adds background space without resizing the captured pixels', () => {
  assert.deepEqual(outputSize({ x: 10, y: 20, width: 3024, height: 1964 }, 64), {
    width: 3152,
    height: 2092,
  });
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 3024, height: 1964 }, 0), {
    width: 3024,
    height: 1964,
  });
  assert.throws(() => outputSize({ x: 0, y: 0, width: 16000, height: 100 }, 64), /limit/);
  assert.throws(() => outputSize({ x: 0, y: 0, width: 8000, height: 8000 }, 0), /limit/);
});
function raster(width: number, height: number, color: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = color(x, y);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}
test('surface analysis finds a panel and nested selected row in original coordinates', () => {
  const image = raster(120, 100, (x, y) => (x >= 40 ? 100 : y >= 30 && y < 60 ? 50 : 20));
  const candidates = detectSurfaceRegions(image, 240, 200);
  assert.ok(candidates.some((rect) => rect.x === 0 && rect.width === 80 && rect.height === 200));
  assert.ok(
    candidates.some(
      (rect) => rect.x === 0 && rect.y === 60 && rect.width === 80 && rect.height === 60,
    ),
  );
  assert.ok(
    candidates.every(
      (rect) =>
        rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 240 && rect.y + rect.height <= 200,
    ),
  );
});
test('a flat screenshot does not invent component boundaries', () => {
  assert.deepEqual(
    detectSurfaceRegions(
      raster(120, 100, () => 25),
      120,
      100,
    ),
    [],
  );
});

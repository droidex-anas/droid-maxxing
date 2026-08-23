import type { BrowserElementRef } from './types.js';

export function centerOfBrowserRef(ref: BrowserElementRef): { x: number; y: number } {
  return {
    x: Math.round(ref.box.x + ref.box.width / 2),
    y: Math.round(ref.box.y + ref.box.height / 2),
  };
}

export function requireBrowserPoint(input: { x?: number; y?: number }): {
  x: number;
  y: number;
} {
  if (input.x === undefined || input.y === undefined) {
    throw new Error('Browser interaction requires either a ref or x/y coordinates.');
  }
  return { x: input.x, y: input.y };
}

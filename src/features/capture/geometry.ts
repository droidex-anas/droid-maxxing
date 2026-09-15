import type { CaptureRect } from './types';
export const MAX_CAPTURE_PIXELS = 48_000_000;

export function clampCrop(rect: CaptureRect, width: number, height: number): CaptureRect {
  if (
    ![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite) ||
    width < 1 ||
    height < 1
  )
    throw new Error('Invalid image geometry');
  const x = Math.min(width - 1, Math.max(0, Math.floor(rect.x)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(rect.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.ceil(rect.width))),
    height: Math.max(1, Math.min(height - y, Math.ceil(rect.height))),
  };
}
export function dragCrop(
  start: { x: number; y: number },
  end: { x: number; y: number },
  width: number,
  height: number,
): CaptureRect {
  return clampCrop(
    {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    },
    width,
    height,
  );
}
function intersection(a: CaptureRect, b: CaptureRect): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
export function snapCrop(
  drag: CaptureRect,
  candidates: readonly CaptureRect[],
  tolerance: number,
): CaptureRect {
  let best = drag;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const deltas = [
      Math.abs(drag.x - candidate.x),
      Math.abs(drag.y - candidate.y),
      Math.abs(drag.x + drag.width - candidate.x - candidate.width),
      Math.abs(drag.y + drag.height - candidate.y - candidate.height),
    ];
    const distance = deltas.reduce((sum, n) => sum + n, 0);
    const union =
      drag.width * drag.height + candidate.width * candidate.height - intersection(drag, candidate);
    if (
      Math.max(...deltas) <= tolerance &&
      intersection(drag, candidate) / union >= 0.7 &&
      distance < bestDistance
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
export function outputSize(crop: CaptureRect, padding: number): { width: number; height: number } {
  const p = Math.round(padding);
  const width = crop.width + p * 2;
  const height = crop.height + p * 2;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    p < 0 ||
    width < 1 ||
    height < 1 ||
    width > 16000 ||
    height > 16000 ||
    width * height > MAX_CAPTURE_PIXELS
  )
    throw new Error(
      'This composition exceeds the 48 megapixel / 16000px limit. Reduce padding or crop the source.',
    );
  return { width, height };
}

import type { CaptureRect } from './types';
import { clampCrop } from './geometry';

export interface RegionCandidate extends CaptureRect {
  label: string;
  confidence: number;
}
interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
function difference(raster: Raster, x1: number, y1: number, x2: number, y2: number): number {
  const a = (y1 * raster.width + x1) * 4;
  const b = (y2 * raster.width + x2) * 4;
  return (
    (Math.abs(raster.data[a] - raster.data[b]) +
      Math.abs(raster.data[a + 1] - raster.data[b + 1]) +
      Math.abs(raster.data[a + 2] - raster.data[b + 2])) /
    3
  );
}
function seams(
  raster: Raster,
  box: CaptureRect,
  vertical: boolean,
): { position: number; strength: number }[] {
  const length = vertical ? box.width : box.height;
  const span = vertical ? box.height : box.width;
  const output = [];
  for (let pos = 10; pos < length - 10; pos += 1) {
    let hits = 0;
    let samples = 0;
    let contrast = 0;
    const step = Math.max(1, Math.floor(span / 200));
    for (let offset = 2; offset < span - 2; offset += step) {
      const x = box.x + (vertical ? pos : offset);
      const y = box.y + (vertical ? offset : pos);
      const delta = difference(raster, x, y, x - (vertical ? 2 : 0), y - (vertical ? 0 : 2));
      if (delta >= 5) hits += 1;
      contrast += Math.min(delta, 40);
      samples += 1;
    }
    const coverage = samples ? hits / samples : 0;
    if (coverage >= 0.7 && contrast / samples >= 5)
      output.push({ position: pos, strength: coverage });
  }
  return output.sort((a, b) => b.strength - a.strength);
}

// Boundary proposals, not semantic recognition. Long coherent color changes
// beat text edges; ambiguous images retain a free crop instead of inventing UI.
export function detectSurfaceRegions(
  raster: Raster,
  sourceWidth: number,
  sourceHeight: number,
): RegionCandidate[] {
  if (
    raster.width < 24 ||
    raster.height < 24 ||
    raster.data.length !== raster.width * raster.height * 4
  )
    return [];
  const candidates: RegionCandidate[] = [];
  const scaleX = sourceWidth / raster.width;
  const scaleY = sourceHeight / raster.height;
  function split(box: CaptureRect, depth: number) {
    if (depth >= 4 || box.width < 28 || box.height < 28 || candidates.length >= 24) return;
    const vertical = seams(raster, box, true).at(0);
    const horizontal = seams(raster, box, false).at(0);
    const useVertical = !!vertical && (!horizontal || vertical.strength >= horizontal.strength);
    const seam = useVertical ? vertical : horizontal;
    if (!seam) return;
    const first = {
      ...box,
      width: useVertical ? seam.position : box.width,
      height: useVertical ? box.height : seam.position,
    };
    const second = {
      x: useVertical ? box.x + seam.position : box.x,
      y: useVertical ? box.y : box.y + seam.position,
      width: useVertical ? box.width - seam.position : box.width,
      height: useVertical ? box.height : box.height - seam.position,
    };
    for (const region of [first, second]) {
      if (region.width < 12 || region.height < 12) continue;
      const crop = clampCrop(
        {
          x: region.x * scaleX,
          y: region.y * scaleY,
          width: region.width * scaleX,
          height: region.height * scaleY,
        },
        sourceWidth,
        sourceHeight,
      );
      candidates.push({
        ...crop,
        label: depth === 0 ? 'Detected panel' : 'Detected section',
        confidence: seam.strength,
      });
      split(region, depth + 1);
    }
  }
  split({ x: 0, y: 0, width: raster.width, height: raster.height }, 0);
  return candidates;
}
export function analyzeCapture(image: HTMLImageElement): RegionCandidate[] {
  const scale = Math.min(1, 720 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const raster = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const regions = detectSurfaceRegions(raster, image.naturalWidth, image.naturalHeight);
  canvas.width = 0;
  canvas.height = 0;
  return regions;
}

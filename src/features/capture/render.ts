import type { CaptureRecipe } from './types';
import { backgroundFor } from './presets';
import { outputSize, MAX_CAPTURE_PIXELS } from './geometry';

export function loadCaptureImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > MAX_CAPTURE_PIXELS) {
        reject(new Error('Image exceeds the 48 megapixel limit'));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('This image could not be decoded'));
    };
    image.src = source;
  });
}
function textureTile(kind: 'grain' | 'cross'): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = 96;
  tile.height = 96;
  const ctx = tile.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  if (kind === 'cross') {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.65;
    for (let y = 3; y < 96; y += 6)
      for (let x = 3; x < 96; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x - 1.4, y - 1.4);
        ctx.lineTo(x + 1.4, y + 1.4);
        ctx.moveTo(x + 1.4, y - 1.4);
        ctx.lineTo(x - 1.4, y + 1.4);
        ctx.stroke();
      }
  } else {
    const pixels = ctx.createImageData(96, 96);
    let seed = 0x193bca71;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const value = (seed >>> 0) % 256;
      pixels.data.set([value, value, value, 140], i);
    }
    ctx.putImageData(pixels, 0, 0);
  }
  return tile;
}

// Preview and export share drawing rules. Only the preview changes scale.
export function drawCapture(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  recipe: CaptureRecipe,
  previewWidth?: number,
): void {
  const { crop, style } = recipe;
  const { width, height } = outputSize(crop, style.padding);
  const scale = previewWidth ? Math.min(1, previewWidth / width, 900 / height) : 1;
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.scale(scale, scale);
  const preset = backgroundFor(style.preset);
  const colors = style.colors ?? preset.colors;
  if (style.preset !== 'transparent') {
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, width, height);
    const radius = Math.max(width, height) * 0.95;
    for (const [x, y, color] of [
      [width * 0.05, height * 0.1, colors[1]],
      [width * 0.95, height * 0.95, colors[2]],
    ] as const) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, `${color}00`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    if (style.texture > 0) {
      const pattern = ctx.createPattern(textureTile(preset.texture), 'repeat');
      if (pattern) {
        ctx.save();
        ctx.globalAlpha = style.texture;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
    }
  }
  const padding = Math.round(style.padding);
  const radius = Math.min(style.radius, crop.width / 2, crop.height / 2);
  if (style.shadow > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.roundRect(padding, padding, crop.width, crop.height, radius);
    ctx.clip('evenodd');
    ctx.shadowColor = `rgba(0,0,0,${String(style.shadow / 160)})`;
    ctx.shadowBlur = style.shadow;
    ctx.shadowOffsetY = style.shadow * 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(padding, padding, crop.width, crop.height, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(padding, padding, crop.width, crop.height, radius);
  ctx.clip();
  ctx.imageSmoothingEnabled = scale !== 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    padding,
    padding,
    crop.width,
    crop.height,
  );
  ctx.restore();
}
export async function exportCapture(
  image: HTMLImageElement,
  recipe: CaptureRecipe,
): Promise<string> {
  const canvas = document.createElement('canvas');
  try {
    drawCapture(canvas, image, recipe);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error('Could not encode capture'));
      }, 'image/png');
    });
    if (blob.size > 40 * 1024 * 1024)
      throw new Error(
        'PNG exceeds 40 MiB. Crop a smaller area; the original has not been changed.',
      );
    return await blobDataUrl(blob);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read image'));
    };
    reader.onerror = () => {
      reject(new Error('Could not read image'));
    };
    reader.readAsDataURL(blob);
  });
}
export async function importCaptureFile(file: File): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 40 * 1024 * 1024
  )
    throw new Error('Choose a PNG, JPEG, or WebP up to 40 MiB');
  const source = await blobDataUrl(file);
  const image = await loadCaptureImage(source);
  if (file.type === 'image/png') return source;
  return exportCapture(image, {
    version: 1,
    crop: { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight },
    style: { preset: 'transparent', padding: 0, radius: 0, shadow: 0, texture: 0 },
  });
}

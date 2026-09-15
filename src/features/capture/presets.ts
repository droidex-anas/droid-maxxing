import type { CapturePreset } from './types';
export interface BackgroundPreset {
  id: CapturePreset;
  name: string;
  colors: readonly [string, string, string];
  swatch: string;
  texture: 'grain' | 'cross';
}
export const BACKGROUNDS: readonly BackgroundPreset[] = [
  {
    id: 'ember',
    name: 'Ember mesh',
    colors: ['#121114', '#733e3a', '#b97232'],
    swatch:
      'radial-gradient(at 15% 20%, #773f45, transparent 65%), radial-gradient(at 90% 90%, #b97232, #121114 80%)',
    texture: 'grain',
  },
  {
    id: 'tide',
    name: 'Halftone tide',
    colors: ['#111b23', '#2697ad', '#ef7544'],
    swatch:
      'radial-gradient(at 0% 10%, #2697ad, transparent 65%), radial-gradient(at 100% 100%, #ef7544, #111b23 80%)',
    texture: 'cross',
  },
  {
    id: 'pearl',
    name: 'Warm pearl',
    colors: ['#e6e2db', '#c8bdd7', '#f5dec4'],
    swatch: 'linear-gradient(135deg, #c8bdd7, #e6e2db 50%, #f5dec4)',
    texture: 'grain',
  },
  {
    id: 'iris',
    name: 'Iris dusk',
    colors: ['#171727', '#6569a0', '#846d8e'],
    swatch:
      'radial-gradient(at 10% 10%, #6569a0, transparent 70%), linear-gradient(135deg,#171727,#846d8e)',
    texture: 'grain',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    colors: ['#151515', '#3a3b3e', '#242426'],
    swatch: 'linear-gradient(135deg, #3a3b3e, #151515)',
    texture: 'grain',
  },
  {
    id: 'transparent',
    name: 'Transparent',
    colors: ['#000000', '#000000', '#000000'],
    swatch: 'repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%) 0 0 / 12px 12px',
    texture: 'grain',
  },
];
export function backgroundFor(id: CapturePreset): BackgroundPreset {
  return BACKGROUNDS.find((item) => item.id === id) ?? BACKGROUNDS[0];
}

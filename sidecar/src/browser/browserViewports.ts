import type { BrowserViewport, BrowserViewportMode } from './types.js';

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
};

export const VIEWPORT_PRESETS: {
  id: BrowserViewportMode;
  label: string;
  viewport?: BrowserViewport;
}[] = [
  { id: 'fit', label: 'Fit' },
  { id: 'desktop', label: 'Desktop', viewport: { width: 1440, height: 900, deviceScaleFactor: 2 } },
  { id: 'laptop', label: 'Laptop', viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } },
  { id: 'tablet', label: 'Tablet', viewport: { width: 820, height: 1180, deviceScaleFactor: 2 } },
  { id: 'mobile', label: 'Mobile', viewport: { width: 390, height: 844, deviceScaleFactor: 2 } },
  { id: 'custom', label: 'Custom' },
];

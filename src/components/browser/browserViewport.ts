import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';

export const FIT_FALLBACK_VIEWPORT: BrowserViewport = {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
};
export const CUSTOM_DEFAULT_VIEWPORT: BrowserViewport = {
  width: 1024,
  height: 720,
  deviceScaleFactor: 2,
};

export const PRESET_VIEWPORTS: Partial<Record<BrowserViewportMode, BrowserViewport>> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 2 },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2 },
};

export function viewportFromFrame(size: Size, edgeToEdge = false): BrowserViewport {
  if (size.width <= 1 || size.height <= 1) return FIT_FALLBACK_VIEWPORT;
  const inset = edgeToEdge ? 0 : 36;
  return {
    width: pixels(size.width - inset),
    height: pixels(size.height - inset),
    deviceScaleFactor: 2,
  };
}

export function viewportForMode(
  mode: BrowserViewportMode,
  fitViewport: BrowserViewport,
  customViewport: BrowserViewport,
): BrowserViewport {
  if (mode === 'fit') return fitViewport;
  if (mode === 'custom') return customViewport;
  return PRESET_VIEWPORTS[mode] ?? fitViewport;
}

export function sameViewport(a: BrowserViewport, b: BrowserViewport): boolean {
  return (
    a.width === b.width && a.height === b.height && a.deviceScaleFactor === b.deviceScaleFactor
  );
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a website address to open.');

  const bareHostWithPort =
    /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z\d-]+(?:\.[a-z\d-]+)+):\d+(?:[/?#]|$)/i.test(
      trimmed,
    );
  const explicitScheme = bareHostWithPort
    ? undefined
    : /^([a-z][a-z\d+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== 'http' && explicitScheme !== 'https') {
    throw new Error('Only http:// and https:// website addresses can be opened.');
  }

  let normalized: string;
  if (explicitScheme) normalized = trimmed;
  else if (trimmed.startsWith('//')) normalized = `https:${trimmed}`;
  else {
    const ipv6Loopback = normalizeBareIpv6Loopback(trimmed);
    if (ipv6Loopback) normalized = ipv6Loopback;
    else if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?([/?#]|$)/i.test(trimmed))
      normalized = `http://${trimmed}`;
    else normalized = `https://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Enter a valid http:// or https:// website address.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Only http:// and https:// website addresses can be opened.');
  }
  return normalized;
}

export function normalizeBrowserOmniboxInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a website address or search terms.');

  const explicitScheme = /\s/.test(trimmed)
    ? undefined
    : /^([a-z][a-z\d+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== 'http' && explicitScheme !== 'https') {
    return normalizeUrl(trimmed);
  }

  if (looksLikeWebsiteAddress(trimmed)) return normalizeUrl(trimmed);
  return `https://www.google.com/search?${new URLSearchParams({ q: trimmed }).toString()}`;
}

function looksLikeWebsiteAddress(value: string): boolean {
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(?:[/?#]|$)/i.test(value)) return true;
  if (/\s|@/.test(value)) return false;
  if (/^\[[\da-f:]+\](?::\d+)?(?:[/?#]|$)/i.test(value)) return true;
  // Unicode-aware labels so bare IDN hosts open instead of falling through to search.
  return /^(?:[^\s@/?#:.]+\.)+[^\s@/?#:.]+(?::\d+)?(?:[/?#]|$)/u.test(value);
}

function normalizeBareIpv6Loopback(value: string): string | null {
  const match = /^::1(?::(\d+))?([/?#].*|)$/i.exec(value);
  if (!match) return null;
  const port = match[1] ? `:${match[1]}` : '';
  const path = match[2];
  return `http://[::1]${port}${path}`;
}

export function browserSurfaceLayout(
  frame: Size,
  viewport: BrowserViewport,
  mode: BrowserViewportMode,
): Size & { left: number; top: number } {
  const padding = 18;
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const width = mode === 'fit' ? availableWidth : Math.min(viewport.width, availableWidth);
  const height = mode === 'fit' ? availableHeight : Math.min(viewport.height, availableHeight);
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pixels(value: number): number {
  return Math.max(1, Math.round(value));
}

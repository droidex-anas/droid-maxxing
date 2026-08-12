export type AppBlockState = 'idle' | 'running';
export type AppBlockAction = 'play' | 'stop';

export const DEFAULT_APP_HEIGHT = 360;
const MIN_APP_HEIGHT = 240;
const MAX_APP_HEIGHT = 640;

export interface AppBlockTheme {
  colorScheme: 'light' | 'dark';
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
}

const DEFAULT_APP_THEME: AppBlockTheme = {
  colorScheme: 'dark',
  background: '#0a0a0a',
  surface: '#111111',
  foreground: '#ededed',
  muted: '#9a9a9a',
  border: '#222222',
  accent: '#f2f2f2',
};

const SAFE_COLOR = /^(#[\da-f]{3,8}|rgba?\([\d.,\s%/]+\)|hsla?\([\d.,\s%/]+\))$/i;

function safeColor(value: string, fallback: string): string {
  const color = value.trim();
  return SAFE_COLOR.test(color) ? color : fallback;
}

function isDarkColor(color: string): boolean {
  const hex = /^#([\da-f]{6})$/i.exec(color)?.[1];
  if (!hex) return true;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 < 128;
}

export function currentAppBlockTheme(): AppBlockTheme {
  if (typeof document === 'undefined') return DEFAULT_APP_THEME;
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    safeColor(styles.getPropertyValue(name), fallback);
  const background = color('--droid-bg', DEFAULT_APP_THEME.background);
  return {
    colorScheme: isDarkColor(background) ? 'dark' : 'light',
    background,
    surface: color('--droid-surface', DEFAULT_APP_THEME.surface),
    foreground: color('--droid-text', DEFAULT_APP_THEME.foreground),
    muted: color('--droid-text-secondary', DEFAULT_APP_THEME.muted),
    border: color('--droid-border-hover', DEFAULT_APP_THEME.border),
    accent: color('--droid-accent', DEFAULT_APP_THEME.accent),
  };
}

export function appBlockReducer(_state: AppBlockState, action: AppBlockAction): AppBlockState {
  return action === 'play' ? 'running' : 'idle';
}

export function normalizeAppBlockHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APP_HEIGHT;
  return Math.min(MAX_APP_HEIGHT, Math.max(MIN_APP_HEIGHT, Math.ceil(value)));
}

export function createAppDocument(
  source: string,
  instanceId: string,
  theme: AppBlockTheme = DEFAULT_APP_THEME,
): string {
  const serializedId = JSON.stringify(instanceId).replaceAll('<', '\\u003c');
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<style>
:root {
  color-scheme: ${theme.colorScheme};
  --app-background: ${theme.background};
  --app-surface: ${theme.surface};
  --app-foreground: ${theme.foreground};
  --app-muted: ${theme.muted};
  --app-border: ${theme.border};
  --app-accent: ${theme.accent};
  font-family: ui-sans-serif, system-ui, sans-serif;
}
html, body { margin: 0; min-width: 0; background: var(--app-background); }
body { box-sizing: border-box; padding: 16px; color: var(--app-foreground); overflow-wrap: anywhere; }
*, *::before, *::after { box-sizing: inherit; }
img, svg, canvas, video { display: block; max-width: 100%; height: auto; }
a { color: var(--app-accent); }
button, input, select, textarea {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-surface);
  color: var(--app-foreground);
  font: inherit;
}
::selection { background: color-mix(in srgb, var(--app-accent) 24%, transparent); }
</style>
<script>
(() => {
  const instanceId = ${serializedId};
  const reportHeight = () => {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    parent.postMessage({ type: 'droidex:app-height', instanceId, height }, '*');
  };
  addEventListener('DOMContentLoaded', () => {
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
    addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }, { once: true });
})();
</script>
</head>
<body>
${source}
</body>
</html>`;
}

export function appBlockHeightFromMessage(data: unknown, instanceId: string): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('type' in data) || data.type !== 'droidex:app-height') return undefined;
  if (!('instanceId' in data) || data.instanceId !== instanceId) return undefined;
  if (!('height' in data) || typeof data.height !== 'number' || !Number.isFinite(data.height)) {
    return undefined;
  }
  return normalizeAppBlockHeight(data.height);
}

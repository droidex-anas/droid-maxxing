export type AppBlockState = 'idle' | 'running';
export type AppBlockAction = 'play' | 'stop';

export const DEFAULT_APP_HEIGHT = 360;
const MIN_APP_HEIGHT = 240;
const MAX_APP_HEIGHT = 12_000;
const MAX_APP_MATH_CHARS = 20_000;

export interface AppBlockMathRequest {
  requestId: string;
  latex: string;
  displayMode: boolean;
}

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

export function hasCompleteAppBlock(markdown: string): boolean {
  return /(?:^|\n)```app[ \t]*\r?\n[\s\S]*?```(?:\r?\n|$)/i.test(markdown);
}

export function hasAppBlock(markdown: string): boolean {
  return /(?:^|\n)```app[ \t]*(?:\r?\n|$)/i.test(markdown);
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
html, body { margin: 0; min-width: 0; background: transparent; }
body { box-sizing: border-box; padding: 0; color: var(--app-foreground); overflow-wrap: anywhere; }
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
  const pendingMath = new Map();
  let mathSequence = 0;
  const reportHeight = () => {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    parent.postMessage({ type: 'droidex:app-height', instanceId, height }, '*');
  };
  const renderMath = (target, latex, options = {}) => {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!(element instanceof Element) || typeof latex !== 'string') return Promise.resolve(false);
    const requestId = instanceId + '-math-' + String(++mathSequence);
    return new Promise((resolve) => {
      pendingMath.set(requestId, { element, resolve });
      parent.postMessage({
        type: 'droidex:render-math',
        instanceId,
        requestId,
        latex,
        displayMode: options.displayMode === true || element.hasAttribute('data-display'),
      }, '*');
    });
  };
  const renderAllMath = (root = document) => Promise.all(
    [...root.querySelectorAll('[data-latex]')].map((element) =>
      renderMath(element, element.getAttribute('data-latex') ?? '')
    )
  );
  const onMathMessage = (event) => {
    const data = event.data;
    if (
      event.source !== parent ||
      !data ||
      data.type !== 'droidex:math-rendered' ||
      data.instanceId !== instanceId ||
      typeof data.requestId !== 'string'
    ) return;
    const pending = pendingMath.get(data.requestId);
    if (!pending) return;
    pendingMath.delete(data.requestId);
    if (typeof data.html === 'string') {
      pending.element.innerHTML = data.html;
      pending.resolve(true);
    } else {
      pending.element.textContent = 'Unable to render this expression.';
      pending.resolve(false);
    }
    reportHeight();
  };
  addEventListener('message', onMathMessage);
  window.droidex = Object.freeze({ renderMath, renderAllMath });
  addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-droidex-app-root]') ??
      [...document.body.children].find((element) => !['SCRIPT', 'STYLE'].includes(element.tagName));
    root?.setAttribute('data-droidex-app-root', '');
    if (root && !root.querySelector('[data-droidex-app-canvas]')) {
      const visualRegions = [...root.children].filter((element) =>
        element.matches('svg, canvas') || element.querySelector('svg, canvas')
      );
      if (visualRegions.length === 1) {
        visualRegions[0].setAttribute('data-droidex-app-canvas', '');
      }
    }
    void renderAllMath();
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
    addEventListener('pagehide', () => {
      observer.disconnect();
      removeEventListener('message', onMathMessage);
      for (const pending of pendingMath.values()) pending.resolve(false);
      pendingMath.clear();
    }, { once: true });
  }, { once: true });
})();
</script>
</head>
<body>
${source}
<style data-droidex-app-host>
html, body { overflow: hidden !important; }
body { min-height: 0 !important; padding: 0 !important; }
[data-droidex-app-root] {
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
[data-droidex-app-canvas] {
  margin-inline: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
</style>
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

export function appBlockMathRequestFromMessage(
  data: unknown,
  instanceId: string,
): AppBlockMathRequest | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('type' in data) || data.type !== 'droidex:render-math') return undefined;
  if (!('instanceId' in data) || data.instanceId !== instanceId) return undefined;
  if (
    !('requestId' in data) ||
    typeof data.requestId !== 'string' ||
    data.requestId.length === 0 ||
    data.requestId.length > 128
  ) {
    return undefined;
  }
  if (
    !('latex' in data) ||
    typeof data.latex !== 'string' ||
    data.latex.length === 0 ||
    data.latex.length > MAX_APP_MATH_CHARS
  ) {
    return undefined;
  }
  if (!('displayMode' in data) || typeof data.displayMode !== 'boolean') return undefined;
  return { requestId: data.requestId, latex: data.latex, displayMode: data.displayMode };
}

export async function renderAppBlockMath(request: AppBlockMathRequest): Promise<string> {
  const { renderToString } = await import('katex');
  return renderToString(request.latex, {
    displayMode: request.displayMode,
    output: 'mathml',
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  });
}

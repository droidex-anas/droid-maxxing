export { hasAppBlock, hasCompleteAppBlock } from '../lib/appBlocks';

export type AppBlockState = 'idle' | 'running';
export type AppBlockAction = 'play' | 'stop';

export const DEFAULT_APP_HEIGHT = 360;
const MIN_APP_HEIGHT = 240;
const MAX_APP_HEIGHT = 12_000;
const MAX_APP_MATH_CHARS = 20_000;
export const MAX_APP_MATH_REQUESTS = 64;
export const MAX_CONCURRENT_APP_MATH_REQUESTS = 2;
const MAX_APP_ERROR_CHARS = 500;

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

export interface AppBridgeGuard {
  acceptHeight: (height: number) => boolean;
  startMath: () => boolean;
  finishMath: () => void;
  fail: () => void;
}

export interface AppBridgeSession {
  token: string;
  guard: AppBridgeGuard;
}

export function createAppBridgeGuard(
  mathBudget = MAX_APP_MATH_REQUESTS,
  mathConcurrency = MAX_CONCURRENT_APP_MATH_REQUESTS,
): AppBridgeGuard {
  let lastHeight: number | undefined;
  let mathStarted = 0;
  let mathInFlight = 0;
  let failed = false;
  return {
    acceptHeight(height) {
      if (failed) return false;
      if (height === lastHeight) return false;
      lastHeight = height;
      return true;
    },
    startMath() {
      if (failed) return false;
      if (mathStarted >= mathBudget || mathInFlight >= mathConcurrency) return false;
      mathStarted += 1;
      mathInFlight += 1;
      return true;
    },
    finishMath() {
      mathInFlight = Math.max(0, mathInFlight - 1);
    },
    fail() {
      failed = true;
    },
  };
}

export function createAppBridgeSession(): AppBridgeSession {
  return {
    token: crypto.randomUUID(),
    guard: createAppBridgeGuard(),
  };
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

const SAFE_COLOR =
  /^(#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|rgba?\([\d.,\s%/]+\)|hsla?\([\d.,\s%/]+\))$/i;

function safeColor(value: string, fallback: string): string {
  const color = value.trim();
  return SAFE_COLOR.test(color) ? color : fallback;
}

function colorChannels(color: string): [number, number, number] | undefined {
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(color)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 || hex.length === 4
        ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
        : hex.slice(0, 6);
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ];
  }

  const rgb = /^rgba?\((.*)\)$/i.exec(color)?.[1];
  if (rgb) {
    const channels = rgb
      .split(/[,\s/]+/)
      .filter(Boolean)
      .slice(0, 3);
    if (channels.length !== 3) return undefined;
    const channelValue = (channel: string) =>
      channel.endsWith('%') ? (Number.parseFloat(channel) / 100) * 255 : Number.parseFloat(channel);
    return [channelValue(channels[0]), channelValue(channels[1]), channelValue(channels[2])];
  }

  const hsl = /^hsla?\((.*)\)$/i.exec(color)?.[1];
  if (!hsl) return undefined;
  const channels = hsl.split(/[,\s/]+/).filter(Boolean);
  if (channels.length < 3) return undefined;
  const hue = ((Number.parseFloat(channels[0]) % 360) + 360) % 360;
  const saturation = Number.parseFloat(channels[1]) / 100;
  const lightness = Number.parseFloat(channels[2]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] =
    segment < 1
      ? [chroma, secondary, 0]
      : segment < 2
        ? [secondary, chroma, 0]
        : segment < 3
          ? [0, chroma, secondary]
          : segment < 4
            ? [0, secondary, chroma]
            : segment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return [(red + match) * 255, (green + match) * 255, (blue + match) * 255];
}

export function appColorScheme(color: string): 'light' | 'dark' {
  const [red, green, blue] = colorChannels(color) ?? [0, 0, 0];
  return red * 0.299 + green * 0.587 + blue * 0.114 < 128 ? 'dark' : 'light';
}

export function currentAppBlockTheme(): AppBlockTheme {
  if (typeof document === 'undefined') return DEFAULT_APP_THEME;
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    safeColor(styles.getPropertyValue(name), fallback);
  const background = color('--droid-bg', DEFAULT_APP_THEME.background);
  return {
    colorScheme: appColorScheme(background),
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
  bridgeToken = instanceId,
): string {
  const serializedId = JSON.stringify(instanceId).replaceAll('<', '\\u003c');
  const serializedBridgeToken = JSON.stringify(bridgeToken).replaceAll('<', '\\u003c');
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
  const bridgeToken = ${serializedBridgeToken};
  const pendingMath = new Map();
  let mathSequence = 0;
  let heightFrame = 0;
  let lastHeight = -1;
  let lastError = '';
  const postError = (message) => {
    const normalized = typeof message === 'string' ? message.trim().slice(0, ${String(MAX_APP_ERROR_CHARS)}) : '';
    if (!normalized || normalized === lastError) return;
    lastError = normalized;
    parent.postMessage({
      type: 'droidex:app-error',
      instanceId,
      bridgeToken,
      message: normalized,
    }, '*');
  };
  const onRuntimeError = (event) => {
    postError(event?.message || 'The interactive App failed to start.');
  };
  const onUnhandledRejection = (event) => {
    const reason = event?.reason;
    postError(reason instanceof Error ? reason.message : String(reason || 'Unhandled App error'));
  };
  addEventListener('error', onRuntimeError);
  addEventListener('unhandledrejection', onUnhandledRejection);
  const reportHeight = () => {
    if (heightFrame) return;
    heightFrame = requestAnimationFrame(() => {
      heightFrame = 0;
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      if (height === lastHeight) return;
      lastHeight = height;
      parent.postMessage({ type: 'droidex:app-height', instanceId, bridgeToken, height }, '*');
    });
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
        bridgeToken,
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
  const postReady = () => {
    parent.postMessage({ type: 'droidex:app-ready', instanceId, bridgeToken }, '*');
  };
  const onHostMessage = (event) => {
    const data = event.data;
    if (
      event.source !== parent ||
      !data ||
      data.instanceId !== instanceId ||
      data.bridgeToken !== bridgeToken
    ) return;
    if (data.type === 'droidex:host-ready') {
      postReady();
      return;
    }
    if (data.type !== 'droidex:math-rendered' || typeof data.requestId !== 'string') return;
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
  addEventListener('message', onHostMessage);
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
    postReady();
    void renderAllMath();
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(document.body);
    if (root && root !== document.body) observer.observe(root);
    addEventListener('pagehide', () => {
      if (heightFrame) cancelAnimationFrame(heightFrame);
      observer.disconnect();
      removeEventListener('message', onHostMessage);
      removeEventListener('error', onRuntimeError);
      removeEventListener('unhandledrejection', onUnhandledRejection);
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

function appBridgeMessageMatches(
  data: unknown,
  instanceId: string,
  bridgeToken?: string,
): data is Record<string, unknown> {
  if (typeof data !== 'object' || data === null) return false;
  if (!('instanceId' in data) || data.instanceId !== instanceId) return false;
  return bridgeToken === undefined || ('bridgeToken' in data && data.bridgeToken === bridgeToken);
}

export function appBlockErrorFromMessage(
  data: unknown,
  instanceId: string,
  bridgeToken: string,
): string | undefined {
  if (!appBridgeMessageMatches(data, instanceId, bridgeToken)) return undefined;
  if (!('type' in data) || data.type !== 'droidex:app-error') return undefined;
  if (!('message' in data) || typeof data.message !== 'string') return undefined;
  const message = data.message.trim();
  if (!message || message.length > MAX_APP_ERROR_CHARS) return undefined;
  return message;
}

export function appBlockReadyFromMessage(
  data: unknown,
  instanceId: string,
  bridgeToken: string,
): boolean {
  return (
    appBridgeMessageMatches(data, instanceId, bridgeToken) &&
    'type' in data &&
    data.type === 'droidex:app-ready'
  );
}

export function appBlockHeightFromMessage(
  data: unknown,
  instanceId: string,
  bridgeToken?: string,
): number | undefined {
  if (!appBridgeMessageMatches(data, instanceId, bridgeToken)) return undefined;
  if (!('type' in data) || data.type !== 'droidex:app-height') return undefined;
  if (!('height' in data) || typeof data.height !== 'number' || !Number.isFinite(data.height)) {
    return undefined;
  }
  return normalizeAppBlockHeight(data.height);
}

export function appBlockMathRequestFromMessage(
  data: unknown,
  instanceId: string,
  bridgeToken?: string,
): AppBlockMathRequest | undefined {
  if (!appBridgeMessageMatches(data, instanceId, bridgeToken)) return undefined;
  if (!('type' in data) || data.type !== 'droidex:render-math') return undefined;
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

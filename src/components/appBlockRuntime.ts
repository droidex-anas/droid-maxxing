export { hasAppBlock, hasCompleteAppBlock, hasIncompleteAppBlock } from '../lib/appBlocks';

export type AppBlockState = 'idle' | 'running';
export type AppBlockAction = 'play' | 'stop';

// Shortest time the build surface stays up once shown, so an App that starts in
// a frame or two reads as a deliberate build instead of a flicker.
export const MIN_APP_BUILD_MS = 180;
// A started App reports its height as soon as it renders. If one never does,
// the frame is revealed at its default height instead of staying hidden behind
// the build surface forever.
export const APP_BUILD_TIMEOUT_MS = 2_000;

// A running frame is revealed once the App has reported a height and the build
// floor has passed, so the reveal lands at the real measured size without
// flashing. The timeout is the escape hatch for an App that never reports.
export function isAppFrameVisible(build: {
  measured: boolean;
  floorElapsed: boolean;
  expired: boolean;
}): boolean {
  return (build.measured && build.floorElapsed) || build.expired;
}

export interface AppHeightScheduler {
  schedule: (height: number) => void;
  cancel: () => void;
}

// Folds a burst of height reports into one application, keeping the newest.
// Deliberately not an animation frame: a hidden or minimized host window runs
// none, and the frame stays behind its build surface until a height lands.
export function createAppHeightScheduler(
  applyHeight: (height: number) => void,
): AppHeightScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: number | undefined;
  return {
    schedule(height) {
      pending = height;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (pending === undefined) return;
        const next = pending;
        pending = undefined;
        applyHeight(next);
      });
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

export const DEFAULT_APP_HEIGHT = 360;
const MIN_APP_HEIGHT = 240;
const MAX_APP_HEIGHT = 12_000;
const MAX_APP_MATH_CHARS = 20_000;
export const MAX_APP_MATH_REQUESTS = 64;
export const MAX_CONCURRENT_APP_MATH_REQUESTS = 2;
export const MAX_APP_ERROR_CHARS = 500;

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

export const DEFAULT_APP_THEME: AppBlockTheme = {
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

export type AppBlockStartupState = 'waiting' | 'ready' | 'failed';

export interface AppBlockStartupTransition {
  state: AppBlockStartupState;
  error?: string;
}

export function appBlockStartupTransition(
  state: AppBlockStartupState,
  data: unknown,
  instanceId: string,
  bridgeToken: string,
): AppBlockStartupTransition {
  if (state !== 'waiting') return { state };
  const error = appBlockErrorFromMessage(data, instanceId, bridgeToken);
  if (error) return { state: 'failed', error };
  if (appBlockReadyFromMessage(data, instanceId, bridgeToken)) return { state: 'ready' };
  return { state };
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

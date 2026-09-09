import type { BrowserRestoreState, BrowserState, BrowserViewportMode } from '../types/bridge';
import { restoreBrowser } from '../lib/commands';

const BROWSER_VIEWPORT_MODES = new Set<BrowserViewportMode>([
  'fit',
  'desktop',
  'laptop',
  'tablet',
  'mobile',
  'custom',
]);

const SENSITIVE_BROWSER_QUERY_KEYS = new Set([
  'access_token',
  'assertion',
  'authorization_code',
  'code',
  'code_verifier',
  'id_token',
  'nonce',
  'oauth_token',
  'refresh_token',
  'relaystate',
  'samlresponse',
  'session_state',
  'state',
  'ticket',
  'token',
]);

const UNAMBIGUOUS_BROWSER_SECRET_KEYS = new Set([
  'access_token',
  'assertion',
  'authorization_code',
  'code_verifier',
  'id_token',
  'oauth_token',
  'refresh_token',
  'samlresponse',
  'ticket',
  'token',
]);

export function restorePersistedBrowserSessions(
  browsers: Record<string, BrowserState>,
  restore: (state: BrowserRestoreState) => void = restoreBrowser,
): void {
  for (const [appSessionId, browser] of Object.entries(browsers)) {
    const url = sanitizePersistedBrowserUrl(browser.url);
    if (!url) continue;
    restore({
      browserSessionId: browser.browserSessionId,
      appSessionId,
      url,
      title: browser.title,
      viewport: browser.viewport,
      viewportMode: browser.viewportMode,
      scroll: browser.scroll,
      canGoBack: browser.canGoBack,
      canGoForward: browser.canGoForward,
    });
  }
}

export function loadPersistedBrowsers(value: unknown): Record<string, BrowserState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, browser]) => [key, sanitizePersistedBrowser(key, browser)] as const)
    .filter((entry): entry is readonly [string, BrowserState] => Boolean(entry[1]));
  return Object.fromEntries(entries);
}

export function loadPersistedBrowserOpenKeys(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Preserve both true (open) and false (explicitly hidden) so the "hidden"
  // decision survives a restart; a dropped `false` would let later updates
  // re-open a pane the user deliberately hid.
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, boolean] =>
      typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'boolean',
  );
  return Object.fromEntries(entries);
}

export function persistBrowsers(
  browsers: Record<string, BrowserState>,
): Record<string, BrowserState> {
  return Object.fromEntries(
    Object.entries(browsers).map(([key, browser]) => [
      key,
      {
        ...browser,
        url: sanitizePersistedBrowserUrl(browser.url),
        refs: [],
        agentCursor: undefined,
        screenshotPath: undefined,
        screenshotUrl: undefined,
      },
    ]),
  );
}

export function sanitizePersistedBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    removeSensitiveBrowserParams(url.searchParams);
    const fragment = url.hash.slice(1);
    if (fragment.includes('?')) {
      const queryIndex = fragment.indexOf('?');
      const route = fragment.slice(0, queryIndex);
      const fragmentParams = new URLSearchParams(fragment.slice(queryIndex + 1));
      const hasSecret = [...fragmentParams.keys()].some((key) =>
        UNAMBIGUOUS_BROWSER_SECRET_KEYS.has(key.toLowerCase()),
      );
      removeSensitiveBrowserParams(
        fragmentParams,
        hasSecret || /(?:^|\/)(?:auth|callback|login|oauth|signin)(?:\/|$)/i.test(route),
      );
      const remaining = fragmentParams.toString();
      url.hash = `#${route}${remaining ? `?${remaining}` : ''}`;
    } else if (fragment.includes('=')) {
      const fragmentParams = new URLSearchParams(
        fragment.startsWith('?') ? fragment.slice(1) : fragment,
      );
      removeSensitiveBrowserParams(fragmentParams);
      const remaining = fragmentParams.toString();
      url.hash = remaining ? `#${remaining}` : '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function sanitizePersistedBrowser(key: string, value: unknown): BrowserState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const browser = value as Partial<BrowserState>;
  if (typeof browser.browserSessionId !== 'string' || !browser.browserSessionId) return undefined;
  if (typeof browser.url !== 'string' || !browser.url) return undefined;
  const viewport = sanitizeBrowserViewport(browser.viewport);
  if (!viewport) return undefined;
  return {
    browserSessionId: browser.browserSessionId,
    appSessionId: key,
    url: browser.url,
    title: typeof browser.title === 'string' ? browser.title : undefined,
    viewport,
    viewportMode: sanitizeBrowserViewportMode(browser.viewportMode),
    scroll: sanitizeBrowserScroll(browser.scroll),
    refs: [],
    ...(browser.canGoBack === true ? { canGoBack: true } : {}),
    ...(browser.canGoForward === true ? { canGoForward: true } : {}),
  };
}

function sanitizeBrowserViewport(value: unknown): BrowserState['viewport'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const viewport = value as Partial<BrowserState['viewport']>;
  const width = finitePositiveNumber(viewport.width);
  const height = finitePositiveNumber(viewport.height);
  const deviceScaleFactor = finitePositiveNumber(viewport.deviceScaleFactor);
  if (!width || !height || !deviceScaleFactor) return undefined;
  return { width, height, deviceScaleFactor };
}

function sanitizeBrowserViewportMode(value: unknown): BrowserViewportMode {
  return BROWSER_VIEWPORT_MODES.has(value as BrowserViewportMode)
    ? (value as BrowserViewportMode)
    : 'fit';
}

function sanitizeBrowserScroll(value: unknown): BrowserState['scroll'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { x: 0, y: 0 };
  const scroll = value as Partial<BrowserState['scroll']>;
  return { x: finiteNumber(scroll.x) ?? 0, y: finiteNumber(scroll.y) ?? 0 };
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number && number > 0 ? number : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function removeSensitiveBrowserParams(params: URLSearchParams, includeAmbiguous = true): void {
  for (const key of [...params.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (
      (includeAmbiguous && SENSITIVE_BROWSER_QUERY_KEYS.has(normalizedKey)) ||
      UNAMBIGUOUS_BROWSER_SECRET_KEYS.has(normalizedKey)
    ) {
      params.delete(key);
    }
  }
}

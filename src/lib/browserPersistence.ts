import type { BrowserRestoreState, BrowserState } from '../types/bridge';
import { restoreBrowser } from './commands';

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
    restore({
      browserSessionId: browser.browserSessionId,
      appSessionId,
      url: browser.url,
      title: browser.title,
      viewport: browser.viewport,
      viewportMode: browser.viewportMode,
      scroll: browser.scroll,
      canGoBack: browser.canGoBack,
      canGoForward: browser.canGoForward,
    });
  }
}

export function sanitizePersistedBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    removeSensitiveBrowserParams(url.searchParams);
    const fragment = url.hash.slice(1);
    if (fragment.startsWith('/') && fragment.includes('?')) {
      const queryIndex = fragment.indexOf('?');
      const route = fragment.slice(0, queryIndex);
      const fragmentParams = new URLSearchParams(fragment.slice(queryIndex + 1));
      const hasSecret = [...fragmentParams.keys()].some((key) =>
        UNAMBIGUOUS_BROWSER_SECRET_KEYS.has(key.toLowerCase()),
      );
      removeSensitiveBrowserParams(
        fragmentParams,
        hasSecret || /\/(?:auth|callback|login|oauth|signin)(?:\/|$)/i.test(route),
      );
      const remaining = fragmentParams.toString();
      url.hash = `#${route}${remaining ? `?${remaining}` : ''}`;
    } else if (fragment && fragment.includes('=')) {
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

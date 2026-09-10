const MAX_BROWSER_URL_LENGTH = 8_192;

// Shared browser URL predicate: http(s) only, no embedded credentials.
// `maxLength` is opt-in: only callers that persist or compare stored URLs cap
// the length. Live page URLs must not be capped -- real sites (dashboards, SAML
// responses, SPA pushState) routinely exceed 8 KiB, and rejecting those would
// break navigation bookkeeping rather than protect anything.
function parseSafeHttpUrl(value, { maxLength } = {}) {
  if (typeof value !== 'string') return null;
  if (maxLength !== undefined && value.length > maxLength) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function isSafeHttpUrl(value, options) {
  return parseSafeHttpUrl(value, options) !== null;
}

// Separates "not a URL at all" from "a URL we refuse": callers report the two
// cases with different messages, so they cannot lean on parseSafeHttpUrl alone.
function isParsableUrl(value, { maxLength } = {}) {
  if (typeof value !== 'string') return false;
  if (maxLength !== undefined && value.length > maxLength) return false;
  return URL.canParse(value);
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function createNativeBrowserUrlPolicy({ appName, getHostAppUrl }) {
  function normalizeNativeBrowserSessionId(browserSessionId) {
    const value = String(browserSessionId || '').trim();
    if (!value) throw new Error(`${appName} browser session id is required.`);
    return value;
  }

  function nativeBrowserUrlsMatch(left, right) {
    if (!left || !right) return false;
    try {
      return new URL(left).href === new URL(right).href;
    } catch {
      return left === right;
    }
  }

  function restorableUrlForEntry(entry, url) {
    if (!url) return undefined;
    const value = normalizeNativeBrowserUrl(entry, url);
    return value === 'about:blank' ||
      isChromeErrorUrl(value) ||
      nativeBrowserUrlsMatch(entry.failedRestoreUrl, value)
      ? undefined
      : value;
  }

  function rememberFailedRestoreUrl(entry, url) {
    if (entry.failedRestoreUrl) return;
    const restoreUrl = normalizeNativeBrowserUrl(entry, url);
    if (restoreUrl !== 'about:blank' && !isChromeErrorUrl(restoreUrl)) {
      entry.failedRestoreUrl = restoreUrl;
    }
  }

  function normalizeNativeBrowserUrl(entry, url) {
    const value = String(url || 'about:blank');
    if (isHostAppUrl(value)) return 'about:blank';
    if (!isChromeErrorUrl(value)) return value;
    return entry?.targetUrl && !isChromeErrorUrl(entry.targetUrl) ? entry.targetUrl : 'about:blank';
  }

  function rejectHostAppUrl(url) {
    if (isHostAppUrl(url)) {
      throw new Error(
        `Cannot open the ${appName} shell inside its own browser pane. Use a different local app port.`,
      );
    }
  }

  function isChromeErrorUrl(url) {
    return String(url || '').startsWith('chrome-error://');
  }

  function isHostAppUrl(url) {
    const host = localAppEndpoint(getHostAppUrl());
    const target = localAppEndpoint(url);
    if (!host || !target) return false;
    if (host.port !== target.port) return false;
    return host.local && target.local;
  }

  // Deliberately permissive: this only compares host/port against the shell's own
  // dev server, so URLs the safe-URL predicate rejects (embedded credentials,
  // over-long) must still be recognised to produce the specific guidance below.
  function localAppEndpoint(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      return {
        local: isLoopbackHost(parsed.hostname),
        port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      };
    } catch {
      return undefined;
    }
  }

  // Bare hosts are normalized to https by the renderer; local dev servers are
  // usually plain http. Retry once over http for private/loopback hosts instead
  // of stranding the pane on a blank error page. Only fall back on
  // ERR_CONNECTION_REFUSED: that unambiguously means nothing is listening on
  // https, so there is no secure connection to downgrade. Certificate or TLS
  // handshake failures mean a real HTTPS server is present, so retrying those
  // over plain http would silently weaken a secure connection.
  function httpFallbackUrl(url, errorCode) {
    const retryableCodes = new Set([
      -102, // ERR_CONNECTION_REFUSED  (no server listening on https)
    ]);
    if (!retryableCodes.has(errorCode)) return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return undefined;
      if (!isPrivateHost(parsed.hostname)) return undefined;
      parsed.protocol = 'http:';
      return parsed.href;
    } catch {
      return undefined;
    }
  }

  function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (isLoopbackHost(host)) return true;
    if (host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.localhost'))
      return true;
    if (!host.includes('.')) return true;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  }

  function validateUrl(value) {
    const parsed = new URL(value);
    if (parsed.href === 'about:blank') return;
    if (!isSafeHttpUrl(parsed.href)) {
      throw new Error('Browser URLs must use http(s) without embedded credentials.');
    }
  }

  function normalizeBounds(bounds) {
    return {
      x: Math.round(bounds?.x ?? 0),
      y: Math.round(bounds?.y ?? 0),
      width: Math.max(1, Math.round(bounds?.width ?? 1)),
      height: Math.max(1, Math.round(bounds?.height ?? 1)),
    };
  }

  function normalizeBrowserViewport(viewport) {
    return {
      width: Math.max(1, Math.round(Number(viewport?.width) || 1200)),
      height: Math.max(1, Math.round(Number(viewport?.height) || 800)),
      deviceScaleFactor: Math.max(0.1, Number(viewport?.deviceScaleFactor) || 2),
    };
  }

  return {
    normalizeNativeBrowserSessionId,
    restorableUrlForEntry,
    rememberFailedRestoreUrl,
    normalizeNativeBrowserUrl,
    rejectHostAppUrl,
    isChromeErrorUrl,
    httpFallbackUrl,
    validateUrl,
    normalizeBounds,
    normalizeBrowserViewport,
  };
}

module.exports = {
  createNativeBrowserUrlPolicy,
  isLoopbackHost,
  isParsableUrl,
  isSafeHttpUrl,
  parseSafeHttpUrl,
  MAX_BROWSER_URL_LENGTH,
};

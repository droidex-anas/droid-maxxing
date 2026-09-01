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

  function isLoadAbortError(err) {
    return (
      String(err?.code || '').includes('ERR_ABORTED') ||
      String(err?.message || '').includes('ERR_ABORTED')
    );
  }

  function isHostAppUrl(url) {
    const host = localAppEndpoint(getHostAppUrl());
    const target = localAppEndpoint(url);
    if (!host || !target) return false;
    if (host.port !== target.port) return false;
    return host.local && target.local;
  }

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

  function isLoopbackHost(hostname) {
    const value = String(hostname || '').toLowerCase();
    return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
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
    if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported browser URL scheme: ${parsed.protocol.replace(':', '')}`);
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
    nativeBrowserUrlsMatch,
    restorableUrlForEntry,
    rememberFailedRestoreUrl,
    normalizeNativeBrowserUrl,
    rejectHostAppUrl,
    isChromeErrorUrl,
    isLoadAbortError,
    isHostAppUrl,
    httpFallbackUrl,
    validateUrl,
    normalizeBounds,
    normalizeBrowserViewport,
  };
}

module.exports = { createNativeBrowserUrlPolicy };

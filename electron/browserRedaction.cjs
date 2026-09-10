// URL/key redaction shared by the main-process diagnostics pipeline
// (browserDiagnostics.cjs) and the sandboxed browser preload, which cannot
// require() at runtime and instead inlines this module at build time.
const SENSITIVE_KEY_PARTS = [
  'token',
  'key',
  'secret',
  'password',
  'passcode',
  'auth',
  'authorization',
  'sig',
  'credential',
  'code',
  'cookie',
  'session',
  'csrf',
  'otp',
  'state',
  'nonce',
  'relaystate',
  'assertion',
  'ticket',
  'samlresponse',
];

function isSensitiveBrowserKey(value) {
  const key = String(value || '').toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => key.includes(part));
}

// Redirect-style parameters carry whole URLs, so their own query strings are
// redacted too; depth is bounded so a nested chain cannot recurse without end.
function redactBrowserDiagnosticUrl(value, baseUrl, depth = 0) {
  try {
    const url = baseUrl ? new URL(String(value), baseUrl) : new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[non-http URL]';
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveBrowserKey(key)) {
        url.searchParams.set(key, '[redacted]');
        continue;
      }
      const nested = url.searchParams.get(key);
      if (/^https?:\/\//i.test(nested)) {
        url.searchParams.set(
          key,
          depth < 2 ? redactBrowserDiagnosticUrl(nested, undefined, depth + 1) : '[redacted]',
        );
      }
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return '[invalid URL]';
  }
}

module.exports = { isSensitiveBrowserKey, redactBrowserDiagnosticUrl };

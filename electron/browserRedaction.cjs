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
  'signature',
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

function redactBrowserDiagnosticUrl(value, baseUrl) {
  try {
    const url = baseUrl ? new URL(String(value), baseUrl) : new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveBrowserKey(key)) {
        url.searchParams.set(key, '[redacted]');
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

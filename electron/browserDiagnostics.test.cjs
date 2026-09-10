const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBrowserConsoleMessage,
  redactBrowserDiagnosticText,
  redactBrowserDiagnosticUrl,
} = require('./browserDiagnostics.cjs');

test('browser console diagnostics redact structured credentials', () => {
  assert.equal(
    redactBrowserDiagnosticText(
      '{"password":"hunter2 with spaces","access_token":"secret-token","safe":"visible"}',
    ),
    '{"password":"[redacted]","access_token":"[redacted]","safe":"visible"}',
  );
  assert.equal(
    redactBrowserDiagnosticText("credential='private value'; authorization=Bearer-value"),
    "credential='[redacted]'; authorization=[redacted]",
  );
  assert.equal(
    redactBrowserDiagnosticText('Authorization: Bearer abc.def-123'),
    'Authorization: [redacted] [redacted]',
  );
  assert.equal(
    redactBrowserDiagnosticText('Cookie: session_id="private value"; Bearer "quoted secret"'),
    'Cookie: [redacted]; Bearer [redacted]',
  );
});

test('browser network diagnostics remove URL credentials and sensitive parameters', () => {
  assert.equal(
    redactBrowserDiagnosticUrl(
      'https://user:pass@example.com/video?access_token=secret&part=snippet#private',
    ),
    'https://example.com/video?access_token=%5Bredacted%5D&part=snippet',
  );
  assert.equal(
    redactBrowserDiagnosticUrl(
      'https://user:pass@example.com/callback?csrf=one&session_id=two&cookie=three&otp=four&safe=yes#private',
    ),
    'https://example.com/callback?csrf=%5Bredacted%5D&session_id=%5Bredacted%5D&cookie=%5Bredacted%5D&otp=%5Bredacted%5D&safe=yes',
  );
  assert.equal(
    redactBrowserDiagnosticUrl('/callback?auth_code=secret&safe=yes', 'https://example.com/page'),
    'https://example.com/callback?auth_code=%5Bredacted%5D&safe=yes',
  );
  assert.equal(
    redactBrowserDiagnosticUrl(
      '/callback?state=secret-state&nonce=secret-nonce&RelayState=saml-state&ticket=one-time&sig=azure-sas&safe=yes',
      'https://example.com/page',
    ),
    'https://example.com/callback?state=%5Bredacted%5D&nonce=%5Bredacted%5D&RelayState=%5Bredacted%5D&ticket=%5Bredacted%5D&sig=%5Bredacted%5D&safe=yes',
  );
  assert.equal(
    redactBrowserDiagnosticUrl(
      'https://example.com/login?next=https%3A%2F%2Fapp.example.com%2Fcb%3Faccess_token%3Dsecret&safe=yes',
    ),
    'https://example.com/login?next=https%3A%2F%2Fapp.example.com%2Fcb%3Faccess_token%3D%255Bredacted%255D&safe=yes',
  );
});

test('browser URL diagnostics fail closed for malformed secret-bearing values', () => {
  const malformed = 'https://user:private-value@[::1/path?access_token=private-value';

  assert.equal(redactBrowserDiagnosticUrl(malformed), '[invalid URL]');
  assert.equal(
    redactBrowserDiagnosticUrl('/?authorization=private-value', 'not a valid base URL'),
    '[invalid URL]',
  );
  assert.equal(
    redactBrowserDiagnosticUrl('javascript:fetch("/?access_token=private-value")'),
    '[non-http URL]',
  );
});

test('nested redirect URLs redact the remainder when the depth budget is exhausted', () => {
  let url =
    'https://user:private-password@example.com/?access_token=private-token#private-fragment';
  for (let depth = 0; depth < 6; depth += 1) {
    url = `https://example.com/?next=${encodeURIComponent(url)}&safe=yes`;
  }
  let redacted = redactBrowserDiagnosticUrl(url);
  for (let depth = 0; depth < 3; depth += 1) {
    const parsed = new URL(redacted);
    assert.equal(parsed.searchParams.get('safe'), 'yes');
    redacted = parsed.searchParams.get('next');
  }
  assert.equal(redacted, '[redacted]');
});

test('browser console redaction stays bounded on adversarial quoted input', () => {
  const value = `password="${'\\\\'.repeat(20_000)}secret" safe=visible`;
  const redacted = redactBrowserDiagnosticText(value);

  assert.ok(redacted.length <= 1000);
  assert.doesNotMatch(redacted, /secret/);
  assert.match(redacted, /^password="\[redacted\]/);
});

test('browser console diagnostics use the Electron details object', () => {
  assert.deepEqual(
    normalizeBrowserConsoleMessage({
      level: 'error',
      message: 'token=secret',
      lineNumber: 42,
      sourceId: 'https://example.com/app.js?api_key=secret',
    }),
    {
      level: 3,
      message: 'token=[redacted]',
      line: 42,
      source: 'https://example.com/app.js?api_key=%5Bredacted%5D',
    },
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeBrowserUrlPolicy,
  isLoopbackHost,
  isSafeHttpUrl,
  MAX_BROWSER_URL_LENGTH,
  parseSafeHttpUrl,
} = require('./nativeBrowserUrls.cjs');

const urls = createNativeBrowserUrlPolicy({
  appName: 'DROIDEX',
  getHostAppUrl: () => 'http://localhost:5173',
});

test('native navigation accepts only HTTP(S) without credentials and internal about:blank', () => {
  for (const value of ['https://example.test', 'http://localhost:3000', 'about:blank']) {
    assert.doesNotThrow(() => urls.validateUrl(value));
  }
  for (const value of [
    'file:///tmp/private.txt',
    'about:settings',
    'javascript:alert(1)',
    'data:text/html,hello',
    'https://user:example-password@example.test',
    'http://[?token=example',
  ]) {
    assert.throws(() => urls.validateUrl(value), undefined, value);
  }
});

test('the app shell cannot open itself through a loopback hostname alias', () => {
  assert.throws(() => urls.rejectHostAppUrl('http://127.0.0.1:5173/path'));
  assert.doesNotThrow(() => urls.rejectHostAppUrl('http://localhost:3000'));
});

test('local HTTP retry never downgrades certificate failures or public sites', () => {
  assert.equal(
    urls.httpFallbackUrl('https://localhost:3000/path', -102),
    'http://localhost:3000/path',
  );
  assert.equal(urls.httpFallbackUrl('https://localhost:3000', -202), undefined);
  assert.equal(urls.httpFallbackUrl('https://example.com', -102), undefined);
});

test('the shared URL predicate rejects credentials and non-web schemes', () => {
  assert.equal(parseSafeHttpUrl('https://example.test/a?b=1').href, 'https://example.test/a?b=1');
  for (const value of [
    'https://user:example-password@example.test',
    'https://user@example.test',
    'file:///tmp/private.txt',
    'about:blank',
    'not a url',
    undefined,
  ]) {
    assert.equal(parseSafeHttpUrl(value), null, String(value).slice(0, 40));
    assert.equal(isSafeHttpUrl(value), false);
  }
  assert.deepEqual(['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST'].map(isLoopbackHost), [
    true,
    true,
    true,
    true,
    true,
  ]);
  assert.equal(isLoopbackHost('example.test'), false);
});

test('URL length is capped only where a caller opts in', () => {
  const longUrl = `https://example.test/${'a'.repeat(MAX_BROWSER_URL_LENGTH)}`;
  assert.equal(parseSafeHttpUrl(longUrl)?.href, longUrl);
  assert.equal(isSafeHttpUrl(longUrl), true);
  assert.equal(parseSafeHttpUrl(longUrl, { maxLength: MAX_BROWSER_URL_LENGTH }), null);
  assert.equal(isSafeHttpUrl(longUrl, { maxLength: MAX_BROWSER_URL_LENGTH }), false);
});

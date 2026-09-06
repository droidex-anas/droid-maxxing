const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserUrlPolicy } = require('./nativeBrowserUrls.cjs');

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

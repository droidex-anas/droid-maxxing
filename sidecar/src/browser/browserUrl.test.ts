import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserUrl } from './browserUrl.js';

test('normalizeBrowserUrl keeps explicit http and https browser URLs', () => {
  assert.equal(normalizeBrowserUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeBrowserUrl('http://127.0.0.1:1420/'), 'http://127.0.0.1:1420/');
});

test('normalizeBrowserUrl makes bare domains and localhost loadable', () => {
  assert.equal(normalizeBrowserUrl('skeina.tech'), 'https://skeina.tech');
  assert.equal(normalizeBrowserUrl('example.com:8443/path'), 'https://example.com:8443/path');
  assert.equal(normalizeBrowserUrl('localhost:1420'), 'http://localhost:1420');
  assert.equal(normalizeBrowserUrl('//example.com/path'), 'https://example.com/path');
  assert.equal(normalizeBrowserUrl('::1:8080/dev'), 'http://[::1]:8080/dev');
});

test('normalizeBrowserUrl rejects non-web and malformed targets', () => {
  for (const value of [
    '',
    'about:blank',
    'file:///tmp/private.txt',
    'data:text/html,hello',
    'javascript:alert(1)',
    'javascript:123',
    'droidex://settings',
    'https://user:password@example.com',
    'https://[invalid',
  ]) {
    assert.throws(() => normalizeBrowserUrl(value), /Browser navigation/);
  }
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCredentialCaptureGuard } = require('./browserCredentialCapture.cjs');

function captureFixture() {
  const view = { webContents: null };
  const contents = {
    destroyed: false,
    url: 'https://accounts.example/login',
    getURL() {
      return this.url;
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
  view.webContents = contents;
  return { entry: { view }, view, contents };
}

test('login capture survives expected same-view navigation within the submitted origin', () => {
  const { entry, contents } = captureFixture();
  const guard = createCredentialCaptureGuard(entry, contents, contents.getURL());
  contents.url = 'https://accounts.example/dashboard';
  assert.equal(guard(), true);
});

test('login capture is canceled on view replacement, destruction, or origin change', () => {
  {
    const { entry, contents } = captureFixture();
    const guard = createCredentialCaptureGuard(entry, contents, contents.getURL());
    entry.view = { webContents: contents };
    assert.equal(guard(), false);
  }
  {
    const { entry, contents } = captureFixture();
    const guard = createCredentialCaptureGuard(entry, contents, contents.getURL());
    contents.destroyed = true;
    assert.equal(guard(), false);
  }
  {
    const { entry, contents } = captureFixture();
    const guard = createCredentialCaptureGuard(entry, contents, contents.getURL());
    contents.url = 'https://attacker.example/dashboard';
    assert.equal(guard(), false);
  }
});

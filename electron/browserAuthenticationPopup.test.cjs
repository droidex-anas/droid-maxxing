const assert = require('node:assert/strict');
const test = require('node:test');
const {
  consumeAuthenticationPopup,
  grantAuthenticationPopup,
  hardenAuthenticationPopup,
} = require('./browserAuthenticationPopup.cjs');

test('authentication popup capabilities are one-use, view-bound, and short-lived', () => {
  const view = {};
  const entry = { documentGeneration: 4, authenticationPopupCapability: null };
  grantAuthenticationPopup(entry, view, 'https://accounts.example/signin', 1_000);

  const response = consumeAuthenticationPopup(
    entry,
    view,
    'https://accounts.example/signin',
    'persist:droidex-browser',
    1_001,
  );

  assert.equal(response.action, 'allow');
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(
    response.overrideBrowserWindowOptions.webPreferences.partition,
    'persist:droidex-browser',
  );
  assert.equal(
    consumeAuthenticationPopup(
      entry,
      view,
      'https://accounts.example/signin',
      'persist:droidex-browser',
      1_002,
    ),
    undefined,
  );

  grantAuthenticationPopup(entry, view, 'https://accounts.example/signin', 1_000);
  assert.equal(
    consumeAuthenticationPopup(
      entry,
      {},
      'https://accounts.example/signin',
      'persist:droidex-browser',
      1_001,
    ),
    undefined,
  );
  grantAuthenticationPopup(entry, view, 'https://accounts.example/signin', 1_000);
  assert.equal(
    consumeAuthenticationPopup(
      entry,
      view,
      'https://accounts.example/signin',
      'persist:droidex-browser',
      11_001,
    ),
    undefined,
  );
});

test('authentication popup capability rejects a different safe destination and is consumed', () => {
  const view = {};
  const entry = { documentGeneration: 2, authenticationPopupCapability: null };
  grantAuthenticationPopup(entry, view, 'https://accounts.example/authorize?client=droidex', 1_000);

  assert.equal(
    consumeAuthenticationPopup(
      entry,
      view,
      'https://accounts.example/authorize?client=attacker',
      'persist:droidex-browser',
      1_001,
    ),
    undefined,
  );
  assert.equal(entry.authenticationPopupCapability, null);
});

test('authentication popup capability rejects an unresolved destination', () => {
  const entry = { documentGeneration: 1, authenticationPopupCapability: null };
  assert.throws(() => grantAuthenticationPopup(entry, {}, undefined), /exact HTTP\(S\) target/);
  assert.equal(entry.authenticationPopupCapability, null);
});

test('authentication popups reject unsafe URLs and prevent unsafe child navigation', () => {
  const view = {};
  const entry = { documentGeneration: 1, authenticationPopupCapability: null };
  grantAuthenticationPopup(entry, view, 'https://accounts.example/signin', 1_000);
  assert.equal(
    consumeAuthenticationPopup(
      entry,
      view,
      'file:///tmp/private',
      'persist:droidex-browser',
      1_001,
    ),
    undefined,
  );

  const handlers = new Map();
  let windowOpenHandler;
  let menuVisible = true;
  const window = {
    setMenuBarVisibility: (visible) => {
      menuVisible = visible;
    },
    webContents: {
      setWindowOpenHandler: (handler) => {
        windowOpenHandler = handler;
      },
      on: (name, handler) => handlers.set(name, handler),
    },
  };
  hardenAuthenticationPopup(window);

  assert.equal(menuVisible, false);
  assert.deepEqual(windowOpenHandler(), { action: 'deny' });
  let prevented = false;
  handlers.get('will-navigate')(
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    'javascript:alert(1)',
  );
  assert.equal(prevented, true);
});

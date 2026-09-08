const assert = require('node:assert/strict');
const test = require('node:test');
const {
  browserTargetBeforeViewClose,
  chooseBrowserReload,
  chooseBrowserRestore,
  isExpectedSupersededLoad,
  requireFreshBrowserSnapshot,
  userVisibleBrowserUrl,
} = require('./browserPageState.cjs');

test('closing a loading view remembers the pending destination for restoration', () => {
  assert.equal(
    browserTargetBeforeViewClose({
      currentUrl: 'https://example.com/previous',
      loadingUrl: 'https://example.com/next',
      targetUrl: 'https://example.com/next',
    }),
    'https://example.com/next',
  );
});

test('trusted renderer navigation keeps the exact hash and sensitive query values', () => {
  assert.equal(
    userVisibleBrowserUrl(
      'https://app.example/callback?code=authorization-code&state=csrf-state#finished',
    ),
    'https://app.example/callback?code=authorization-code&state=csrf-state#finished',
  );
});

test('trusted renderer navigation accepts only the internal blank page outside HTTP', () => {
  assert.equal(userVisibleBrowserUrl('about:blank'), 'about:blank');
  assert.throws(() => userVisibleBrowserUrl('javascript:alert(1)'), /invalid page URL/);
});

test('page URLs longer than 8 KiB stay valid so navigation events keep flowing', () => {
  const longUrl = `https://dashboard.example/d/board?state=${'a'.repeat(9_000)}`;
  assert.equal(userVisibleBrowserUrl(longUrl), longUrl);
  assert.deepEqual(chooseBrowserReload({ currentUrl: longUrl }), {
    kind: 'reload',
    url: longUrl,
  });
});

test('agent inspection keeps the live page instead of restoring an older remembered site', () => {
  assert.equal(
    chooseBrowserRestore({
      currentUrl: 'https://www.google.com/search?q=droidex',
      targetUrl: 'https://x.com/home',
      homePage: 'https://www.google.com/',
    }),
    null,
  );
});

test('agent inspection restores the last page only when the renderer is blank', () => {
  assert.equal(
    chooseBrowserRestore({
      currentUrl: 'about:blank',
      targetUrl: 'https://x.com/home',
      homePage: 'https://www.google.com/',
    }),
    'https://x.com/home',
  );
});

test('reload keeps the live page when remembered state points at an older site', () => {
  assert.deepEqual(
    chooseBrowserReload({
      currentUrl: 'https://www.google.com/search?q=droidex',
      targetUrl: 'https://x.com/home',
      homePage: 'https://www.google.com/',
    }),
    { kind: 'reload', url: 'https://www.google.com/search?q=droidex' },
  );
});

test('reload preserves an in-flight navigation instead of reverting to the previous page', () => {
  assert.deepEqual(
    chooseBrowserReload({
      currentUrl: 'https://example.com/previous',
      loadingUrl: 'https://example.com/next',
      targetUrl: 'https://example.com/next',
      homePage: 'https://www.google.com/',
    }),
    { kind: 'load', url: 'https://example.com/next' },
  );
});

test('reload ignores a superseded loading URL after the newer target commits', () => {
  assert.deepEqual(
    chooseBrowserReload({
      currentUrl: 'https://example.com/new-page',
      loadingUrl: 'https://example.com/superseded',
      targetUrl: 'https://example.com/new-page',
      homePage: 'https://www.google.com/',
    }),
    { kind: 'reload', url: 'https://example.com/new-page' },
  );
});

test('reload recovers a blank renderer from the last valid page', () => {
  assert.deepEqual(
    chooseBrowserReload({
      currentUrl: 'about:blank',
      targetUrl: 'https://x.com/home',
      homePage: 'https://www.google.com/',
    }),
    { kind: 'load', url: 'https://x.com/home' },
  );
});

test('reload recovers a failed renderer before falling back to the home page', () => {
  assert.deepEqual(
    chooseBrowserReload({
      currentUrl: 'chrome-error://chromewebdata/',
      failedRestoreUrl: 'https://example.com/account',
      targetUrl: null,
      homePage: 'https://www.google.com/',
    }),
    { kind: 'load', url: 'https://example.com/account' },
  );
});

test('reload opens the configured home page when no page has loaded yet', () => {
  assert.deepEqual(
    chooseBrowserReload({
      currentUrl: 'about:blank',
      targetUrl: null,
      homePage: 'https://search.example/',
    }),
    { kind: 'load', url: 'https://search.example/' },
  );
});

test('browser actions reject missing and internal-error snapshots instead of fabricating success', () => {
  assert.throws(
    () => requireFreshBrowserSnapshot(undefined, 'request-1'),
    /did not return a result/,
  );
  assert.throws(
    () => requireFreshBrowserSnapshot({ requestId: 'request-1', ok: true }, 'request-1'),
    /fresh page snapshot/,
  );
  assert.throws(
    () =>
      requireFreshBrowserSnapshot(
        {
          requestId: 'request-1',
          ok: true,
          snapshot: { url: 'chrome-error://chromewebdata/', scroll: { x: 0, y: 0 }, refs: [] },
        },
        'request-1',
      ),
    /valid page snapshot/,
  );
});

test('only an aborted load superseded by a different live target is ignored', () => {
  const aborted = Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED' });
  assert.equal(
    isExpectedSupersededLoad({
      error: aborted,
      requestedUrl: 'https://example.com/first',
      targetUrl: 'https://example.com/second',
      currentUrl: 'https://example.com/second',
    }),
    true,
  );
  assert.equal(
    isExpectedSupersededLoad({
      error: new Error('ERR_FAILED'),
      requestedUrl: 'https://example.com/first',
      targetUrl: 'https://example.com/second',
      currentUrl: 'https://example.com/second',
    }),
    false,
  );
  assert.equal(
    isExpectedSupersededLoad({
      error: aborted,
      requestedUrl: 'https://example.com/first',
      targetUrl: 'https://example.com/first',
      currentUrl: 'chrome-error://chromewebdata/',
    }),
    false,
  );
});

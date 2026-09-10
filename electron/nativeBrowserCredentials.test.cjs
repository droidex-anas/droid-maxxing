const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserCredentials } = require('./nativeBrowserCredentials.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const calls = { capture: [], authorize: [], scripts: [] };
  let currentUrl = 'https://site.test/login';
  const contents = {
    isDestroyed: () => false,
    getURL: () => currentUrl,
    executeJavaScript: async (script) => {
      calls.scripts.push(script);
      if (script.includes('__DROIDMAXX_AUTH_INTENT')) return overrides.intent;
      if (script.includes('__DROIDMAXX_FILL_CREDENTIALS')) return { ok: true };
      return { snapshot: { url: 'https://site.test/login' } };
    },
    ...overrides.contents,
  };
  const view = { webContents: contents };
  const entry = {
    browserSessionId: 'browser-1',
    view,
    documentGeneration: 3,
    authenticationPopupCapability: null,
    networkEvents: [{ url: 'https://site.test/private' }],
    consoleEvents: [{ message: 'private' }],
  };
  const browserSettings = {
    captureCredential: async (input) => calls.capture.push(input),
    credentialForAgent: async () => {
      if (overrides.credential) return overrides.credential.promise;
      return { username: 'person', password: 'secret' };
    },
    authorizeAuthenticationAction: async (intent) => {
      calls.authorize.push(intent);
      if (overrides.approval) return overrides.approval.promise;
      return true;
    },
  };
  const credentials = createNativeBrowserCredentials({
    browserSettings,
    partition: 'persist:droidex-browser',
    safeWebContents: (candidate) => candidate?.webContents ?? null,
    now: () => 1_000,
  });
  return {
    calls,
    contents,
    credentials,
    entry,
    setCurrentUrl: (url) => {
      currentUrl = url;
    },
    view,
  };
}

test('credential capture survives same-origin submit navigation but rejects origin changes', async () => {
  const { calls, contents, credentials, entry, setCurrentUrl } = harness();

  await credentials.capture(entry, contents, 'https://site.test/login', {
    username: 'person',
    password: 'secret',
    kind: 'password',
  });

  assert.equal(calls.capture.length, 1);
  assert.deepEqual(
    { ...calls.capture[0], isStillValid: undefined },
    {
      url: 'https://site.test/login',
      username: 'person',
      password: 'secret',
      kind: 'password',
      isStillValid: undefined,
    },
  );
  assert.equal(calls.capture[0].isStillValid(), true);
  entry.documentGeneration += 1;
  setCurrentUrl('https://site.test/account');
  assert.equal(calls.capture[0].isStillValid(), true);
  setCurrentUrl('https://other.test/account');
  assert.equal(calls.capture[0].isStillValid(), false);
});

test('saved-login fill sends nothing after the document changes during approval', async () => {
  const credential = deferred();
  const { calls, contents, credentials, entry } = harness({ credential });
  const fill = credentials.fillForAgent(entry, contents, { requestId: 'request-1' });
  entry.documentGeneration += 1;
  credential.resolve({ username: 'person', password: 'secret' });

  assert.deepEqual(await fill, {
    requestId: 'request-1',
    ok: false,
    error: 'The page changed while saved-login use was being approved. Nothing was filled.',
  });
  assert.deepEqual(calls.scripts, []);
});

test('saved-login fill sends nothing after the caller abandons the request', async () => {
  const credential = deferred();
  const { calls, contents, credentials, entry } = harness({ credential });
  const fill = credentials.fillForAgent(entry, contents, { requestId: 'request-1' });
  entry.canceledRequestId = 'request-1';
  credential.resolve({ username: 'person', password: 'secret' });

  assert.equal((await fill).ok, false);
  assert.deepEqual(calls.scripts, []);
});

test('saved-login fill clears diagnostics without returning secrets', async () => {
  const { calls, contents, credentials, entry } = harness();

  const result = await credentials.fillForAgent(entry, contents, { requestId: 'request-1' });

  assert.deepEqual(result, {
    requestId: 'request-1',
    ok: true,
    snapshot: { url: 'https://site.test/login' },
  });
  assert.deepEqual(entry.networkEvents, []);
  assert.deepEqual(entry.consoleEvents, []);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(calls.scripts.length, 2);
});

for (const request of [
  { action: 'click', ref: 'ref-1' },
  { action: 'keypress', key: 'Enter' },
]) {
  test(`saved-login fill does not approve a later sign-in ${request.action}`, async () => {
    const intent = { kind: 'signin', origin: 'https://site.test', label: 'Sign in' };
    const approval = deferred();
    const { calls, contents, credentials, entry } = harness({ intent, approval });
    assert.equal((await credentials.fillForAgent(entry, contents, { requestId: 'fill' })).ok, true);

    const signIn = credentials.authorizeAuthentication(entry, contents, request);
    await Promise.resolve();
    assert.deepEqual(calls.authorize, [{ ...intent, targetUrl: undefined }]);
    approval.resolve(true);
    await signIn;
  });
}

test('denying sign-in after saved-login fill rejects the authentication action', async () => {
  const intent = { kind: 'signin', origin: 'https://site.test', label: 'Sign in' };
  const approval = deferred();
  const { calls, contents, credentials, entry } = harness({ intent, approval });
  await credentials.fillForAgent(entry, contents, { requestId: 'fill' });
  const signIn = credentials.authorizeAuthentication(entry, contents, {
    action: 'click',
    ref: 'ref-1',
  });
  const rejected = assert.rejects(signIn, /Sign-in was denied/);
  approval.reject(new Error('Sign-in was denied'));
  await rejected;
  assert.equal(calls.authorize.length, 1);
  assert.equal(
    calls.scripts.filter((script) => script.includes('__DROIDMAXX_AUTH_INTENT')).length,
    1,
  );
  assert.equal(entry.authenticationPopupCapability, null);
});

test('authentication approval is document-bound and grants only the inspected popup target', async () => {
  const intent = {
    kind: 'oauth',
    origin: 'https://site.test',
    targetUrl: 'https://identity.test/oauth',
    label: 'Continue',
  };
  const { calls, contents, credentials, entry, view } = harness({ intent });

  await credentials.authorizeAuthentication(entry, contents, {
    action: 'click',
    ref: 'ref-1',
  });

  assert.equal(calls.authorize.length, 1);
  assert.equal(calls.scripts.length, 2);
  assert.deepEqual(entry.authenticationPopupCapability, {
    view,
    documentGeneration: 3,
    targetUrl: 'https://identity.test/oauth',
    expiresAt: 11_000,
  });
});

test('authentication approval sends no click after the document changes', async () => {
  const approval = deferred();
  const intent = { kind: 'signin', origin: 'https://site.test', label: 'Sign in' };
  const { calls, contents, credentials, entry } = harness({ approval, intent });
  const authorize = credentials.authorizeAuthentication(entry, contents, {
    action: 'click',
    ref: 'ref-1',
  });
  await Promise.resolve();
  entry.documentGeneration += 1;
  approval.resolve(true);

  await assert.rejects(authorize, /page changed while authentication was being approved/i);
  assert.equal(calls.scripts.length, 1);
});

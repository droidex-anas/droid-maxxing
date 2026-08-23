const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApi(invokeResult) {
  const calls = [];
  const listeners = [];
  const removedListeners = [];
  let api;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      return Promise.resolve(invokeResult);
    },
    on(channel, listener) {
      listeners.push({ channel, listener });
    },
    removeListener(channel, listener) {
      removedListeners.push({ channel, listener });
    },
  };
  const source = readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
      return {
        contextBridge: {
          exposeInMainWorld(_name, exposed) {
            api = exposed;
          },
        },
        ipcRenderer,
      };
    },
  });
  return { api, calls, listeners, removedListeners };
}

test('notification IPC returns the main-process delivery result unchanged', async () => {
  const expected = { shown: false, reason: 'failed', message: 'disabled' };
  const { api, calls } = loadApi(expected);

  assert.deepEqual(
    await api.notify('DROIDEX', 'Finished', { silent: true, appSessionId: 'app-1' }),
    expected,
  );
  assert.equal(calls[0].channel, 'notify');
  assert.equal(calls[0].payload.title, 'DROIDEX');
  assert.equal(calls[0].payload.body, 'Finished');
  assert.equal(calls[0].payload.silent, true);
  assert.equal(calls[0].payload.appSessionId, 'app-1');
});

test('native browser exposes only the canonical agent-action command path', async () => {
  const { api, calls } = loadApi();
  const request = {
    requestId: 'request-1',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'open',
    url: 'https://example.test',
  };

  await api.nativeBrowserAgentAction(request);

  assert.equal(calls[0].channel, 'native-browser-agent-action');
  assert.deepEqual(calls[0].payload.request, request);
  assert.equal(api.nativeBrowserOpen, undefined);
  assert.equal(api.nativeBrowserClose, undefined);
  assert.equal(api.nativeBrowserReload, undefined);
  assert.equal(api.nativeBrowserCapture, undefined);
});

test('browser permission prompts expose removable show and dismiss subscriptions', () => {
  const shown = [];
  const dismissed = [];
  const { api, listeners, removedListeners } = loadApi();

  const stopShow = api.onBrowserPermissionPrompt((payload) => shown.push(payload));
  const stopDismiss = api.onBrowserPermissionPromptDismiss((requestId) =>
    dismissed.push(requestId),
  );

  listeners[0].listener({}, { requestId: 'prompt-1', title: 'Permission' });
  listeners[1].listener({}, 'prompt-1');
  assert.deepEqual(shown, [{ requestId: 'prompt-1', title: 'Permission' }]);
  assert.deepEqual(dismissed, ['prompt-1']);

  stopShow();
  stopDismiss();
  assert.deepEqual(
    removedListeners.map(({ channel }) => channel),
    ['browser-permission-prompt', 'browser-permission-prompt-dismiss'],
  );
});

test('guided Chrome profile import uses only opaque identifiers across the preload bridge', async () => {
  const { api, calls } = loadApi();

  await api.browserCookieProfilesDiscover();
  await api.browserCookieProfileImportPrepare('Profile 1');
  await api.browserCookieProfileImportCommit('plan-1');
  await api.browserCookieProfileImportDiscard('plan-1');

  assert.deepEqual(
    calls.map(({ channel }) => channel),
    [
      'browser-cookie-profiles-discover',
      'browser-cookie-profile-import-prepare',
      'browser-cookie-profile-import-commit',
      'browser-cookie-profile-import-discard',
    ],
  );
  assert.equal(calls[0].payload, undefined);
  assert.equal(calls[1].payload.profileId, 'Profile 1');
  assert.equal(calls[2].payload.planId, 'plan-1');
  assert.equal(calls[3].payload.planId, 'plan-1');
});

test('cookie file recovery has no renderer-controlled browser source', async () => {
  const { api, calls } = loadApi();

  await api.browserCookiesImport();

  assert.deepEqual(calls[0], { channel: 'browser-cookies-import', payload: undefined });
});

test('git turn baseline IPC carries its provisional owner', async () => {
  const { api, calls } = loadApi();

  await api.gitMarkTurnStart('/repo', 'client-1');

  assert.equal(calls[0].channel, 'git-mark-turn-start');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.ownerId, 'client-1');
});

test('git turn baseline adoption IPC correlates client and app session identities', async () => {
  const { api, calls } = loadApi();

  await api.gitAdoptTurnBaseline('/repo', 'client-1', 'app-1');

  assert.equal(calls[0].channel, 'git-adopt-turn-baseline');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.clientRef, 'client-1');
  assert.equal(calls[0].payload.appSessionId, 'app-1');
});

test('app icon IPC carries the selected mode', async () => {
  const { api, calls } = loadApi();

  await api.setAppIcon('dark');
  await api.setAppIcon('system');

  assert.equal(calls[0].channel, 'app-set-icon');
  assert.equal(calls[0].payload.mode, 'dark');
  assert.equal(calls[1].channel, 'app-set-icon');
  assert.equal(calls[1].payload.mode, 'system');
});

test('app update download does not accept a renderer-supplied URL', async () => {
  const { api, calls } = loadApi();

  await api.downloadAppUpdate();

  assert.equal(calls[0].channel, 'app-download-update');
  assert.equal(calls[0].payload, undefined);
});

test('automatic diagnostics preference uses closed IPC payloads', async () => {
  const { api, calls } = loadApi();

  await api.getAutomaticDiagnostics();
  await api.setAutomaticDiagnostics(false);

  assert.deepEqual(calls[0], { channel: 'diagnostics-preference-get', payload: undefined });
  assert.equal(calls[1].channel, 'diagnostics-preference-set');
  assert.equal(calls[1].payload.enabled, false);
});

test('GitHub setup IPC accepts no renderer-controlled command payload', async () => {
  const expected = { ok: true };
  const { api, calls } = loadApi(expected);

  assert.deepEqual(await api.githubInstall(), expected);
  assert.deepEqual(await api.githubAuthenticate(), expected);
  assert.deepEqual(await api.githubCancelSetup(), expected);
  assert.deepEqual(calls[0], { channel: 'github-install', payload: undefined });
  assert.deepEqual(calls[1], { channel: 'github-authenticate', payload: undefined });
  assert.deepEqual(calls[2], { channel: 'github-cancel-setup', payload: undefined });
});

test('GitHub device codes use a removable trusted event subscription', () => {
  const received = [];
  const { api, listeners, removedListeners } = loadApi();

  const unsubscribe = api.onGithubAuthCode((payload) => received.push(payload));
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].channel, 'github-auth-code');

  listeners[0].listener({}, { code: 'ABCD-7HJK' });
  assert.deepEqual(received, [{ code: 'ABCD-7HJK' }]);

  unsubscribe();
  assert.equal(removedListeners.length, 1);
  assert.equal(removedListeners[0].channel, 'github-auth-code');
  assert.equal(removedListeners[0].listener, listeners[0].listener);
});

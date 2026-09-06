const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserNavigation } = require('./nativeBrowserNavigation.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function harness(overrides = {}) {
  let now = 100;
  const approvals = [];
  const loads = [];
  const contents = {
    isDestroyed: () => false,
    getURL: () => 'https://current.test/page',
  };
  const view = { webContents: contents };
  const entry = {
    browserSessionId: 'browser-1',
    view,
    navigationGeneration: 2,
    documentGeneration: 4,
    pendingAgentNavigation: null,
    trustedUserNavigation: null,
    agentActionActive: false,
    userNavigationActive: false,
    agentRequest: { autonomy: 'medium' },
  };
  const navigation = createNativeBrowserNavigation({
    browserSettings: {
      authorizeAgentOrigin: async (url, autonomy) => {
        approvals.push({ url, autonomy });
        return overrides.approval ? overrides.approval.promise : true;
      },
    },
    loadUrl: async (_entry, url, options) => {
      loads.push({ url, options });
      return overrides.loadResult ?? { ok: true };
    },
    safeWebContents: (candidate) => candidate?.webContents ?? null,
    now: () => now,
  });
  return {
    approvals,
    entry,
    loads,
    navigation,
    setNow: (value) => {
      now = value;
    },
    view,
  };
}

test('trusted physical navigation is exact, generation-bound, and single-use', () => {
  const { approvals, entry, navigation, setNow, view } = harness();
  navigation.recordTrustedUserNavigation(entry, view, 'activation-1', 'https://next.test/path');

  setNow(500);
  assert.equal(
    navigation.authorizeTransition(entry, view, 'navigate', 'https://next.test/path'),
    true,
  );
  assert.equal(
    navigation.authorizeTransition(entry, view, 'navigate', 'https://next.test/path'),
    false,
  );
  assert.equal(approvals.length, 1);
});

test('agent activity cannot mint trusted physical navigation provenance', () => {
  const { entry, navigation, view } = harness();
  entry.agentActionActive = true;

  assert.equal(
    navigation.recordTrustedUserNavigation(
      entry,
      view,
      'trusted-hover-event',
      'https://next.test/path',
    ),
    false,
  );
  assert.equal(entry.trustedUserNavigation, null);
});

test('cross-origin transition begins one approval and consumes its successful load', async () => {
  const approval = deferred();
  const { approvals, entry, loads, navigation, view } = harness({ approval });

  assert.equal(
    navigation.authorizeTransition(entry, view, 'popup', 'https://next.test/path'),
    false,
  );
  assert.equal(
    navigation.authorizeTransition(entry, view, 'popup', 'https://next.test/path'),
    false,
  );
  assert.equal(approvals.length, 1);
  approval.resolve(true);

  assert.equal(await navigation.consumePendingApproval(entry), true);
  assert.deepEqual(loads, [{ url: 'https://next.test/path', options: { force: true } }]);
  assert.equal(entry.pendingAgentNavigation, null);
});

test('failed approved navigation rejects instead of reporting success', async () => {
  const { entry, navigation, view } = harness({
    loadResult: { ok: false, error: 'connection refused' },
  });

  navigation.authorizeTransition(entry, view, 'redirect', 'https://next.test/path');

  await assert.rejects(navigation.consumePendingApproval(entry), /connection refused/);
  assert.equal(entry.pendingAgentNavigation, null);
});

test('invalidating navigation while approval is open prevents the deferred load', async () => {
  const approval = deferred();
  const { entry, loads, navigation, view } = harness({ approval });
  navigation.authorizeTransition(entry, view, 'navigate', 'https://next.test/path');
  const pending = entry.pendingAgentNavigation;

  navigation.invalidate(entry);
  approval.resolve(true);

  await assert.rejects(pending.promise, /browser session changed|canceled/i);
  assert.deepEqual(loads, []);
});

test('same-origin and active user transitions do not request agent approval', () => {
  const { approvals, entry, navigation, view } = harness();

  assert.equal(
    navigation.authorizeTransition(entry, view, 'navigate', 'https://current.test/next'),
    true,
  );
  entry.userNavigationActive = true;
  assert.equal(
    navigation.authorizeTransition(entry, view, 'redirect', 'https://next.test/path'),
    true,
  );
  assert.deepEqual(approvals, []);
});

test('document navigation clears physical trust without canceling an approved load', () => {
  const { entry, navigation } = harness();
  entry.trustedUserNavigation = { activationId: 'old' };

  navigation.clearTrustedUserNavigation(entry);

  assert.equal(entry.trustedUserNavigation, null);
  assert.equal(entry.navigationGeneration, 2);
});

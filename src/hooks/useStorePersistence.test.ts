import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPersistedUiState, normalizeDiffStyle } from './useStore';
import type { BrowserRestoreState } from '../types/bridge';
import { normalizeAppIconMode } from '../lib/appIcon';
import {
  restorePersistedBrowserSessions,
  sanitizePersistedBrowserUrl,
} from '../lib/browserPersistence';
import {
  applyFactoryCompactionDefaults,
  compactionSettingsSnapshot,
  loadCompactionTokenLimitPerModel,
} from '../lib/compactionSettings';

test('loadPersistedUiState returns an empty snapshot when storage is empty', () => {
  withLocalStorage(null, () => {
    assert.deepEqual(loadPersistedUiState(), {});
  });
});

test('normalizeDiffStyle migrates the legacy symbol style and rejects invalid values', () => {
  assert.equal(normalizeDiffStyle('soft'), 'soft');
  assert.equal(normalizeDiffStyle('focused'), 'focused');
  assert.equal(normalizeDiffStyle('symbol'), 'focused');
  assert.equal(normalizeDiffStyle('unknown'), 'soft');
});

test('normalizeAppIconMode defaults missing and invalid values to system', () => {
  assert.equal(normalizeAppIconMode('light'), 'light');
  assert.equal(normalizeAppIconMode('dark'), 'dark');
  assert.equal(normalizeAppIconMode('system'), 'system');
  assert.equal(normalizeAppIconMode(undefined), 'system');
  assert.equal(normalizeAppIconMode('bogus'), 'system');
});

test('loadPersistedUiState sanitizes persisted shell fields', () => {
  withLocalStorage(
    JSON.stringify({
      activeAppSessionId: 'm1',
      rightPanelOpen: false,
      sidebarCollapsed: true,
      specMode: true,
      missionControlMode: false,
      selectedChild: {
        parentAppSessionId: 'm1',
        childSessionId: 'stale-child',
      },
      utilityPanels: {
        m1: {
          open: true,
          activeTabId: 'terminal-1',
          tabs: [
            { id: 'review', tool: 'review', label: 'Review' },
            {
              id: 'terminal-1',
              tool: 'terminal',
              label: 'Terminal',
              terminalId: 'pty-1',
            },
          ],
        },
      },
      browserOpenKeys: { 'chat-1': true, 'chat-2': false, '': true },
      browsers: {
        'chat-1': {
          browserSessionId: 'browser-chat-1',
          appSessionId: 'wrong-stale-owner',
          url: 'http://127.0.0.1:17777/',
          title: 'Local app',
          viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
          viewportMode: 'fit',
          scroll: { x: 3, y: 7 },
          refs: [{ stale: true }],
          agentCursor: { x: 1, y: 2 },
          screenshotPath: '/tmp/old.png',
        },
        bad: { url: 'https://example.com' },
      },
      selectedFeatureId: 'f1',
      settingsOpen: true,
    }),
    () => {
      assert.deepEqual(loadPersistedUiState(), {
        activeAppSessionId: 'm1',
        rightPanelOpen: false,
        sidebarCollapsed: true,
        specMode: true,
        missionControlMode: false,
        utilityPanels: {
          m1: {
            open: true,
            activeTabId: 'review',
            tabs: [{ id: 'review', tool: 'review', label: 'Review' }],
          },
        },
        browserOpenKeys: { 'chat-1': true, 'chat-2': false },
        browsers: {
          'chat-1': {
            browserSessionId: 'browser-chat-1',
            appSessionId: 'chat-1',
            url: 'http://127.0.0.1:17777/',
            title: 'Local app',
            viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
            viewportMode: 'fit',
            scroll: { x: 3, y: 7 },
            refs: [],
          },
        },
        selectedFeatureId: 'f1',
      });
    },
  );
});

test('startup restoration preserves each persisted browser task identity', () => {
  const restored: BrowserRestoreState[] = [];

  restorePersistedBrowserSessions(
    {
      'app-background': {
        browserSessionId: 'browser-background',
        appSessionId: 'wrong-stale-owner',
        url: 'https://background.example.test',
        viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
        viewportMode: 'fit',
        scroll: { x: 0, y: 10 },
        refs: [],
      },
      'app-visible': {
        browserSessionId: 'browser-visible',
        appSessionId: 'app-visible',
        url: 'https://visible.example.test',
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
        viewportMode: 'mobile',
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    },
    (state) => restored.push(state),
  );

  assert.deepEqual(
    restored.map((state) => [state.appSessionId, state.browserSessionId, state.url]),
    [
      ['app-background', 'browser-background', 'https://background.example.test'],
      ['app-visible', 'browser-visible', 'https://visible.example.test'],
    ],
  );
});

test('browser URL persistence removes OAuth secrets without corrupting routes', () => {
  assert.equal(
    sanitizePersistedBrowserUrl(
      'https://app.example.test/callback?tab=activity&code=secret&state=nonce&access_token=bearer#/workspace?panel=review',
    ),
    'https://app.example.test/callback?tab=activity#/workspace?panel=review',
  );
  assert.equal(
    sanitizePersistedBrowserUrl(
      'https://app.example.test/#/callback?panel=review&code=secret&state=nonce',
    ),
    'https://app.example.test/#/callback?panel=review',
  );
  assert.equal(
    sanitizePersistedBrowserUrl('https://app.example.test/#/workspace?code=view&state=expanded'),
    'https://app.example.test/#/workspace?code=view&state=expanded',
  );
  assert.equal(
    sanitizePersistedBrowserUrl(
      'https://app.example.test/callback#access_token=bearer&id_token=identity&state=nonce&tab=activity',
    ),
    'https://app.example.test/callback#tab=activity',
  );
  assert.equal(sanitizePersistedBrowserUrl('not a browser URL'), '');
});

test('factory defaults do not restore a cleared per-model compaction override', () => {
  withLocalStorageMap(
    {
      'droid-compaction-token-limit-per-model': '{}',
      'droid-compaction-token-limit-per-model-configured': '1',
    },
    () => {
      assert.deepEqual(
        applyFactoryCompactionDefaults(
          { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
          { compactionTokenLimitPerModel: { 'model-a': 100_000 } },
        ),
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
      );
    },
  );
});

test('factory defaults do not restore a cleared global compaction token limit', () => {
  withLocalStorageMap({ 'droid-compaction-token-limit-configured': '1' }, () => {
    assert.deepEqual(
      applyFactoryCompactionDefaults(
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
        { compactionTokenLimit: 100_000 },
      ),
      { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
    );
  });
});

test('factory defaults seed compaction token limits before local settings exist', () => {
  const storage = new Map<string, string>();
  withLocalStorageMap(storage, () => {
    assert.deepEqual(
      applyFactoryCompactionDefaults(
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
        { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 100_000 } },
      ),
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 100_000 } },
    );
    assert.equal(storage.get('droid-compaction-token-limit'), '200000');
    assert.equal(storage.get('droid-compaction-token-limit-per-model'), '{"model-a":100000}');
  });
});

test('compaction settings snapshots distinguish cold startup from explicit clears', () => {
  withLocalStorageMap({}, () => {
    assert.deepEqual(
      compactionSettingsSnapshot({
        compactionTokenLimit: undefined,
        compactionTokenLimitPerModel: {},
      }),
      {},
    );
  });

  withLocalStorageMap(
    {
      'droid-compaction-token-limit-configured': '1',
      'droid-compaction-token-limit-per-model': '{}',
      'droid-compaction-token-limit-per-model-configured': '1',
    },
    () => {
      assert.deepEqual(
        compactionSettingsSnapshot({
          compactionTokenLimit: undefined,
          compactionTokenLimitPerModel: {},
        }),
        { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      );
    },
  );
});

test('pre-marker per-model limits survive the first defaults event after upgrade', () => {
  // Storage written before the marker keys existed carries per-model data but
  // no configured marker. Loading must stamp it as user-configured so the
  // startup FACTORY_DEFAULTS seed cannot wipe it.
  const storage = new Map<string, string>([
    ['droid-compaction-token-limit-per-model', '{"model-a":150000}'],
  ]);
  withLocalStorageMap(storage, () => {
    const loaded = loadCompactionTokenLimitPerModel();
    assert.deepEqual(loaded, { 'model-a': 150_000 });
    assert.equal(storage.get('droid-compaction-token-limit-per-model-configured'), '1');
    assert.deepEqual(
      applyFactoryCompactionDefaults(
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: loaded },
        { compactionTokenLimitPerModel: { 'model-a': 100_000 } },
      ).compactionTokenLimitPerModel,
      { 'model-a': 150_000 },
    );
    assert.equal(storage.get('droid-compaction-token-limit-per-model'), '{"model-a":150000}');
  });
});

test('a seeded CLI default never turns into an explicit UI override', () => {
  // The Factory-defaults seed writes the value keys for display, but without
  // the user-configured markers the snapshot must stay empty: the sidecar
  // keeps following the session's own limit and the CLI file instead of a
  // frozen first-seen seed.
  const storage = new Map<string, string>();
  withLocalStorageMap(storage, () => {
    const seeded = applyFactoryCompactionDefaults(
      { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 100_000 } },
    );
    assert.equal(storage.get('droid-compaction-token-limit'), '200000');
    assert.deepEqual(compactionSettingsSnapshot(seeded), {});
    // A later CLI-file change keeps flowing through instead of the first seed.
    assert.deepEqual(applyFactoryCompactionDefaults(seeded, { compactionTokenLimit: 300_000 }), {
      compactionTokenLimit: 300_000,
      compactionTokenLimitPerModel: {},
    });
    // Reloading seeded data must not migrate it into a user override: the '0'
    // marker distinguishes a fresh seed from legacy pre-marker storage.
    loadCompactionTokenLimitPerModel();
    assert.equal(storage.get('droid-compaction-token-limit-per-model-configured'), '0');
    assert.deepEqual(compactionSettingsSnapshot(seeded), {});
  });
});

function withLocalStorage(value: string | null, fn: () => void): void {
  withLocalStorageMap(value === null ? {} : { 'droid-ui-state-v2': value }, fn);
}

function withLocalStorageMap(
  seed: Record<string, string> | Map<string, string>,
  fn: () => void,
): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = seed instanceof Map ? seed : new Map(Object.entries(seed));
  const mock: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, next) => {
      values.set(key, next);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: mock,
  });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

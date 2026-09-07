const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  BrowserProfileCookieImportCommitError,
  BrowserProfileCookieImportError,
  commitChromeProfileCookieImport,
  createChromeProfileCookieImportPlan,
  discardChromeProfileCookieImportPlan,
  discoverBrowserCookieProfiles,
} = require('./browserProfileCookieImport.cjs');

const NOW_MS = Date.UTC(2026, 0, 1);
const KEYCHAIN_PASSWORD = 'test-safe-storage-password';

async function createTestHome(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'droidex-chrome-profile-test-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function chromeRoot(homeDir) {
  return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
}

async function createChromeProfiles(t, profileDefinitions, localStateOverrides = {}) {
  const homeDir = await createTestHome(t);
  const root = chromeRoot(homeDir);
  await fs.mkdir(root, { recursive: true });
  const infoCache = {};
  for (const profile of profileDefinitions) {
    infoCache[profile.id] = { name: profile.label };
    const databasePath =
      profile.cookieLocation === 'profile'
        ? path.join(root, profile.id, 'Cookies')
        : path.join(root, profile.id, 'Network', 'Cookies');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    createCookieDatabase(databasePath, profile.rows || [], profile.schemaVersion);
  }
  await fs.writeFile(
    path.join(root, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: infoCache,
        last_used: profileDefinitions[0]?.id,
        ...localStateOverrides,
      },
    }),
  );
  return homeDir;
}

test('discovery supports Chrome profiles whose cookie store is directly under the profile', async (t) => {
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Personal',
      cookieLocation: 'profile',
      rows: [{ hostKey: 'example.com', name: 'sid', plaintextValue: 'private' }],
    },
  ]);

  const discovery = await discoverBrowserCookieProfiles({ platform: 'darwin', homeDir });

  assert.equal(discovery.chrome.status, 'available');
  assert.deepEqual(discovery.chrome.profiles, [
    { id: 'Default', label: 'Personal', isLastUsed: true },
  ]);
});

function createCookieDatabase(databasePath, rows, schemaVersion = 24) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('version', '${schemaVersion}');
      CREATE TABLE cookies(
        host_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        has_expires INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        samesite INTEGER NOT NULL,
        top_frame_site_key TEXT NOT NULL,
        last_update_utc INTEGER NOT NULL,
        creation_utc INTEGER NOT NULL
      );
    `);
    const insert = database.prepare(`
      INSERT INTO cookies(
        host_key, name, value, encrypted_value, path, expires_utc,
        has_expires, is_secure, is_httponly, samesite,
        top_frame_site_key, last_update_utc, creation_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, row] of rows.entries()) {
      const expiresUtc =
        row.expiresUtc ??
        (row.expirationUnix
          ? BigInt(Math.trunc(row.expirationUnix + 11_644_473_600)) * 1_000_000n
          : 0n);
      insert.run(
        row.hostKey,
        row.name,
        row.plaintextValue || '',
        row.encryptedValue || Buffer.alloc(0),
        row.path || '/',
        expiresUtc,
        expiresUtc > 0n ? 1 : 0,
        row.secure ? 1 : 0,
        row.httpOnly ? 1 : 0,
        row.sameSite ?? -1,
        row.topFrameSiteKey || '',
        row.lastUpdateUtc ?? index + 1,
        row.creationUtc ?? index + 1,
      );
    }
  } finally {
    database.close();
  }
}

function encryptedCookieValue(hostKey, value, password = KEYCHAIN_PASSWORD) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  try {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([
      crypto.createHash('sha256').update(hostKey).digest(),
      Buffer.from(value),
    ]);
    return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()]);
  } finally {
    key.fill(0);
  }
}

test('discovery exposes safe Chrome profile metadata and a truthful Safari limitation', async (t) => {
  const homeDir = await createChromeProfiles(
    t,
    [
      { id: 'Default', label: 'Work' },
      { id: 'Profile 1', label: 'Bad\nLabel' },
      { id: 'System Profile', label: 'Internal' },
    ],
    {
      last_used: 'Profile 1',
      info_cache: {
        Default: { name: 'Work' },
        'Profile 1': { name: 'Bad\nLabel' },
        'System Profile': { name: 'Internal' },
        '../../Escape': { name: 'Traversal' },
      },
    },
  );

  const discovery = await discoverBrowserCookieProfiles({ platform: 'darwin', homeDir });

  assert.equal(discovery.chrome.status, 'available');
  assert.deepEqual(discovery.chrome.profiles, [
    { id: 'Profile 1', label: 'Profile 1', isLastUsed: true },
    { id: 'Default', label: 'Work', isLastUsed: false },
  ]);
  assert.equal(discovery.safari.status, 'unavailable');
  assert.match(discovery.safari.message, /macOS protects Safari website data/);
  assert.equal(
    discovery.safari.recovery,
    'Sign in to Safari sites directly inside DROIDEX when you need those accounts.',
  );
  assert.doesNotMatch(discovery.safari.recovery, /export|file|Finder|JSON|Netscape/i);
  assert.doesNotMatch(
    JSON.stringify(discovery),
    new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.ok(Object.isFrozen(discovery));
  assert.ok(Object.isFrozen(discovery.chrome.profiles));
});

test('discovery keeps the last-used Chrome profile when more than 50 stores exist', async (t) => {
  const profiles = [
    { id: 'Default', label: 'Default' },
    ...Array.from({ length: 50 }, (_, index) => ({
      id: `Profile ${index + 1}`,
      label: `Profile ${index + 1}`,
    })),
  ];
  const homeDir = await createChromeProfiles(t, profiles, { last_used: 'Profile 50' });

  const discovery = await discoverBrowserCookieProfiles({ platform: 'darwin', homeDir });

  assert.equal(discovery.chrome.profiles.length, 50);
  assert.deepEqual(discovery.chrome.profiles[0], {
    id: 'Profile 50',
    label: 'Profile 50',
    isLastUsed: true,
  });
});

test('discovery is explicit about unsupported platforms', async () => {
  const discovery = await discoverBrowserCookieProfiles({
    platform: 'win32',
    homeDir: '/unused',
  });

  assert.equal(discovery.chrome.status, 'unavailable');
  assert.match(discovery.chrome.message, /macOS only/);
  assert.equal(discovery.safari.status, 'unavailable');
});

test('Chrome planning asks Keychain once, writes nothing, dedupes, and hides secrets', async (t) => {
  const hostKey = '.example.com';
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Personal',
      rows: [
        {
          hostKey,
          name: 'session',
          encryptedValue: encryptedCookieValue(hostKey, 'old-secret'),
          secure: true,
          httpOnly: true,
          sameSite: 1,
        },
        {
          hostKey,
          name: 'session',
          encryptedValue: encryptedCookieValue(hostKey, 'new-secret'),
          secure: true,
          httpOnly: true,
          sameSite: 1,
        },
        {
          hostKey: 'plain.example',
          name: 'plain',
          plaintextValue: 'plain-secret',
          sameSite: -1,
        },
        {
          hostKey: 'expired.example',
          name: 'expired',
          plaintextValue: 'expired-secret',
          expirationUnix: NOW_MS / 1_000 - 1,
        },
        {
          hostKey: 'partitioned.example',
          name: 'partitioned',
          plaintextValue: 'partition-secret',
          topFrameSiteKey: 'https://top.example',
        },
        {
          hostKey: 'hash.example',
          name: 'bad-hash',
          encryptedValue: encryptedCookieValue('other.example', 'hash-secret'),
          secure: true,
        },
        {
          hostKey: 'insecure.example',
          name: 'insecure-none',
          plaintextValue: 'insecure-secret',
          sameSite: 0,
        },
      ],
    },
  ]);
  let keychainReadCount = 0;
  const writes = [];
  const cookieStore = {
    get: async () => [
      { domain: '.example.com', path: '/', name: 'session', value: 'existing-secret' },
      { domain: 'plain.example', path: '/', name: 'plain', value: 'existing-plain' },
    ],
    set: async (cookie) => writes.push(cookie),
  };

  const plan = await createChromeProfileCookieImportPlan(
    {
      profileId: 'Default',
      cookieStore,
      platform: 'darwin',
      homeDir,
      now: () => NOW_MS,
    },
    {
      readKeychainPassword: async () => {
        keychainReadCount += 1;
        return Buffer.from(KEYCHAIN_PASSWORD);
      },
    },
  );

  assert.equal(keychainReadCount, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(plan.preview, {
    source: 'chrome',
    importMethod: 'profile',
    profileId: 'Default',
    profileLabel: 'Personal',
    importCount: 2,
    skippedCount: 5,
    replacementCount: 2,
    domainCount: 2,
    affectedDomains: ['example.com', 'plain.example'],
    keychainApproved: true,
  });
  assert.deepEqual(Object.keys(plan), ['preview']);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /"session"|"plain"|old-secret|new-secret|existing-secret|hash-secret/,
  );

  const result = await commitChromeProfileCookieImport(plan, { cookieStore });

  assert.deepEqual(
    writes.map((cookie) => [cookie.name, cookie.value]),
    [
      ['session', 'new-secret'],
      ['plain', 'plain-secret'],
    ],
  );
  assert.equal(result.importedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /session|new-secret|plain-secret/);
  await assert.rejects(
    commitChromeProfileCookieImport(plan, { cookieStore }),
    /invalid, expired, or already used/,
  );
});

test('Keychain denial is sanitized and performs no cookie writes', async (t) => {
  const hostKey = 'example.com';
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Personal',
      rows: [
        {
          hostKey,
          name: 'session',
          encryptedValue: encryptedCookieValue(hostKey, 'never-expose-this'),
          secure: true,
        },
      ],
    },
  ]);
  let writeCount = 0;

  let error;
  try {
    await createChromeProfileCookieImportPlan(
      {
        profileId: 'Default',
        platform: 'darwin',
        homeDir,
        cookieStore: { set: async () => (writeCount += 1) },
      },
      {
        readKeychainPassword: async () => {
          throw new Error('denied while handling never-expose-this');
        },
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof BrowserProfileCookieImportError);
  assert.equal(error.code, 'CHROME_KEYCHAIN_ACCESS_DENIED');
  assert.match(error.message, /not approved in macOS Keychain/);
  assert.doesNotMatch(JSON.stringify(error), /never-expose-this|session/);
  assert.equal(writeCount, 0);
});

test('schema validation happens before Keychain access', async (t) => {
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Future',
      schemaVersion: 25,
      rows: [
        {
          hostKey: 'example.com',
          name: 'session',
          encryptedValue: Buffer.from('encrypted-secret'),
        },
      ],
    },
  ]);
  let keychainReadCount = 0;

  await assert.rejects(
    createChromeProfileCookieImportPlan(
      { profileId: 'Default', platform: 'darwin', homeDir },
      {
        readKeychainPassword: async () => {
          keychainReadCount += 1;
          return Buffer.from(KEYCHAIN_PASSWORD);
        },
      },
    ),
    (error) =>
      error instanceof BrowserProfileCookieImportError &&
      error.code === 'CHROME_COOKIE_SCHEMA_UNSUPPORTED',
  );
  assert.equal(keychainReadCount, 0);
});

test('oversized Chrome cookie text and blobs are rejected before Keychain access', async (t) => {
  const malformedRows = [
    { hostKey: 'text.example', name: 'session', plaintextValue: 'x'.repeat(4_097) },
    {
      hostKey: 'blob.example',
      name: 'session',
      encryptedValue: Buffer.alloc(4_148, 1),
      secure: true,
    },
  ];

  for (const [index, row] of malformedRows.entries()) {
    const homeDir = await createChromeProfiles(t, [
      { id: 'Default', label: `Malformed ${index}`, rows: [row] },
    ]);
    let keychainReadCount = 0;

    await assert.rejects(
      createChromeProfileCookieImportPlan(
        { profileId: 'Default', platform: 'darwin', homeDir },
        {
          readKeychainPassword: async () => {
            keychainReadCount += 1;
            return Buffer.from(KEYCHAIN_PASSWORD);
          },
        },
      ),
      (error) =>
        error instanceof BrowserProfileCookieImportError &&
        error.code === 'CHROME_COOKIE_DATABASE_UNAVAILABLE',
    );
    assert.equal(keychainReadCount, 0);
  }
});

test('Chrome planning reads real 64-bit timestamps without unsafe number coercion', async (t) => {
  const chromeTimestamp = 13_423_221_653_433_961n;
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Current Chrome',
      rows: [
        {
          hostKey: 'timestamp.example',
          name: 'session',
          plaintextValue: 'timestamp-secret',
          expiresUtc: chromeTimestamp,
          lastUpdateUtc: chromeTimestamp,
          creationUtc: chromeTimestamp,
        },
      ],
    },
  ]);
  const writes = [];
  const cookieStore = { set: async (cookie) => writes.push(cookie) };

  const plan = await createChromeProfileCookieImportPlan({
    profileId: 'Default',
    platform: 'darwin',
    homeDir,
    now: () => NOW_MS,
  });

  assert.equal(plan.preview.importCount, 1);
  assert.doesNotMatch(JSON.stringify(plan), /session|timestamp-secret/);
  await commitChromeProfileCookieImport(plan, { cookieStore });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expirationDate, 1_778_748_053.433961);
});

test('partial commits are secret-free, continue safely, and consume the plan', async (t) => {
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Personal',
      rows: [
        { hostKey: 'a.example', name: 'first', plaintextValue: 'first-secret' },
        { hostKey: 'b.example', name: 'second', plaintextValue: 'second-secret' },
        { hostKey: 'c.example', name: 'third', plaintextValue: 'third-secret' },
      ],
    },
  ]);
  const attemptedNames = [];
  const cookieStore = {
    get: async () => [
      { domain: 'a.example', path: '/', name: 'first' },
      { domain: 'b.example', path: '/', name: 'second' },
    ],
    set: async (cookie) => {
      attemptedNames.push(cookie.name);
      if (cookie.name === 'second') throw new Error(`rejected ${cookie.value}`);
    },
  };
  const plan = await createChromeProfileCookieImportPlan({
    profileId: 'Default',
    cookieStore,
    platform: 'darwin',
    homeDir,
  });
  assert.equal(plan.preview.replacementCount, 2);

  let error;
  try {
    await commitChromeProfileCookieImport(plan, { cookieStore });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof BrowserProfileCookieImportCommitError);
  assert.equal(error.code, 'BROWSER_PROFILE_COOKIE_IMPORT_PARTIAL');
  assert.equal(error.result.importedCount, 2);
  assert.equal(error.result.failedCount, 1);
  assert.equal(error.result.replacementCount, 1);
  assert.deepEqual(error.result.affectedDomains, ['a.example', 'c.example']);
  assert.deepEqual(attemptedNames, ['first', 'second', 'third']);
  assert.doesNotMatch(JSON.stringify(error.result), /first|second|third|secret/);
  await assert.rejects(
    commitChromeProfileCookieImport(plan, { cookieStore }),
    /invalid, expired, or already used/,
  );
  assert.deepEqual(attemptedNames, ['first', 'second', 'third']);
});

test('discard destroys an uncommitted direct-import plan', async (t) => {
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Personal',
      rows: [{ hostKey: 'example.com', name: 'sid', plaintextValue: 'private' }],
    },
  ]);
  let writeCount = 0;
  const cookieStore = { set: async () => (writeCount += 1) };
  const plan = await createChromeProfileCookieImportPlan({
    profileId: 'Default',
    platform: 'darwin',
    homeDir,
  });

  assert.equal(discardChromeProfileCookieImportPlan(plan), true);
  assert.equal(discardChromeProfileCookieImportPlan(plan), false);
  await assert.rejects(
    commitChromeProfileCookieImport(plan, { cookieStore }),
    /invalid, expired, or already used/,
  );
  assert.equal(writeCount, 0);
});

test('profile identifiers cannot escape Chrome user data', async (t) => {
  const homeDir = await createChromeProfiles(t, [{ id: 'Default', label: 'Personal' }]);

  await assert.rejects(
    createChromeProfileCookieImportPlan({
      profileId: '../../Default',
      platform: 'darwin',
      homeDir,
    }),
    (error) =>
      error instanceof BrowserProfileCookieImportError && error.code === 'CHROME_PROFILE_INVALID',
  );
});

test('direct profile import enforces the 5000-cookie safety limit', async (t) => {
  const homeDir = await createChromeProfiles(t, [
    {
      id: 'Default',
      label: 'Large profile',
      rows: Array.from({ length: 5_001 }, (_, index) => ({
        hostKey: `site-${index}.example`,
        name: 'cookie',
        plaintextValue: 'value',
      })),
    },
  ]);

  await assert.rejects(
    createChromeProfileCookieImportPlan({
      profileId: 'Default',
      platform: 'darwin',
      homeDir,
    }),
    (error) =>
      error instanceof BrowserProfileCookieImportError &&
      error.code === 'CHROME_PROFILE_COOKIE_LIMIT_EXCEEDED',
  );
});

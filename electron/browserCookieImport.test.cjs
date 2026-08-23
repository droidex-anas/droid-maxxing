const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BrowserCookieImportCommitError,
  COOKIE_EXPORT_LIMIT_BYTES,
  commitCookieBatch,
  commitBrowserCookieImport,
  createBrowserCookieImportPlan,
  discardBrowserCookieImportPlan,
} = require('./browserCookieImport.cjs');

const NOW_MS = Date.UTC(2026, 0, 1);

test('cookie batches cap writes at eight and account for only successful replacements', async () => {
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    domain: `site-${index % 11}.example`,
    id: index,
    secret: Buffer.alloc(8, (index % 254) + 1),
  }));
  const replacementKeys = new Set(items.filter(({ id }) => id % 2 === 0).map(({ id }) => id));
  const pendingWrites = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;

  const committing = commitCookieBatch(items, {
    cookieKey: ({ id }) => id,
    dispose: ({ secret }) => secret.fill(0),
    domain: ({ domain }) => domain,
    replacementKeys,
    write: ({ id }) =>
      new Promise((resolve, reject) => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        pendingWrites.push(() => {
          activeWrites -= 1;
          if (id % 10 === 0) reject(new Error('expected write failure'));
          else resolve();
        });
      }),
  });

  let releasedWrites = 0;
  while (releasedWrites < items.length) {
    await new Promise((resolve) => setImmediate(resolve));
    const batch = pendingWrites.splice(0);
    assert.ok(batch.length > 0);
    releasedWrites += batch.length;
    for (const release of batch) release();
  }

  const result = await committing;
  assert.equal(maxActiveWrites, 8);
  assert.deepEqual(result, {
    importedCount: 4_500,
    failedCount: 500,
    replacementCount: 2_000,
    domainCount: 11,
    affectedDomains: [
      'site-0.example',
      'site-1.example',
      'site-10.example',
      'site-2.example',
      'site-3.example',
      'site-4.example',
      'site-5.example',
      'site-6.example',
      'site-7.example',
      'site-8.example',
      'site-9.example',
    ],
  });
  assert.equal(
    items.every(({ secret }) => secret.every((byte) => byte === 0)),
    true,
  );
});

async function writeExport(t, contents, fileName = 'cookies.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'droidex-cookie-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, contents);
  return filePath;
}

test('planning clears the bounded file-read buffer after parsing', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([{ domain: 'example.com', name: 'session', value: 'private-value' }]),
  );
  const originalAllocate = Buffer.allocUnsafe;
  let readBuffer;
  Buffer.allocUnsafe = (size) => {
    const buffer = originalAllocate(size);
    if (size === COOKIE_EXPORT_LIMIT_BYTES + 1) readBuffer = buffer;
    return buffer;
  };
  t.after(() => {
    Buffer.allocUnsafe = originalAllocate;
  });

  const plan = await createBrowserCookieImportPlan({ filePath, now: () => NOW_MS });

  assert.ok(readBuffer);
  assert.equal(
    readBuffer.every((byte) => byte === 0),
    true,
  );
  discardBrowserCookieImportPlan(plan);
});

test('planning is write-free, opaque, deduplicated, and reports replacements', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([
      { domain: '.example.com', path: '/', name: 'session', value: 'old', secure: true },
      { domain: '.example.com', path: '/', name: 'session', value: 'new', secure: true },
      { url: 'file:///tmp/private', path: '/', name: 'local', value: 'file-secret' },
      {
        domain: 'expired.example',
        path: '/',
        name: 'expired',
        value: 'expired-secret',
        expirationDate: NOW_MS / 1_000 - 1,
      },
    ]),
  );
  const writes = [];
  const cookieStore = {
    get: async () => [
      { domain: '.example.com', path: '/', name: 'session', value: 'existing-secret' },
    ],
    set: async (cookie) => writes.push(cookie),
  };

  const plan = await createBrowserCookieImportPlan({
    filePath,
    cookieStore,
    now: () => NOW_MS,
  });

  assert.deepEqual(writes, []);
  assert.deepEqual(plan.preview, {
    source: 'chrome',
    profileLabel: 'Chrome export',
    importCount: 1,
    skippedCount: 3,
    replacementCount: 1,
    domainCount: 1,
    affectedDomains: ['example.com'],
  });
  assert.deepEqual(Object.keys(plan), ['preview']);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /old|new|file-secret|expired-secret|existing-secret|session/,
  );

  const result = await commitBrowserCookieImport(plan, { cookieStore });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, 'new');
  assert.deepEqual(result, {
    source: 'chrome',
    profileLabel: 'Chrome export',
    importedCount: 1,
    failedCount: 0,
    skippedCount: 3,
    replacementCount: 1,
    domainCount: 1,
    affectedDomains: ['example.com'],
  });
  await assert.rejects(
    commitBrowserCookieImport(plan, { cookieStore }),
    /invalid, expired, or already used/,
  );
});

test('Chrome Netscape recovery supports HttpOnly cookies without exposing their contents', async (t) => {
  const filePath = await writeExport(
    t,
    [
      '# Netscape HTTP Cookie File',
      '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\tsid\tprivate-value',
      'malformed',
    ].join('\n'),
    'cookies.txt',
  );
  const writes = [];
  const plan = await createBrowserCookieImportPlan({
    filePath,
    now: () => NOW_MS,
  });

  assert.deepEqual(plan.preview, {
    source: 'chrome',
    profileLabel: 'Chrome export',
    importCount: 1,
    skippedCount: 1,
    replacementCount: null,
    domainCount: 1,
    affectedDomains: ['example.com'],
  });
  assert.doesNotMatch(JSON.stringify(plan), /sid|private-value/);

  const result = await commitBrowserCookieImport(plan, {
    cookieStore: { set: async (cookie) => writes.push(cookie) },
  });

  assert.equal(writes[0].httpOnly, true);
  assert.equal(writes[0].domain, '.example.com');
  assert.equal(writes[0].value, 'private-value');
  assert.doesNotMatch(JSON.stringify(result), /sid|private-value/);
});

test('planning strictly skips unsupported or unsafe cookie attributes', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([
      {
        url: 'https://user:password@example.com',
        path: '/',
        name: 'embedded-credentials',
        value: 'secret',
      },
      {
        domain: 'example.com',
        path: '/',
        name: 'insecure-none',
        value: 'secret',
        sameSite: 'none',
      },
      {
        domain: 'example.com',
        path: '/',
        name: 'partitioned',
        value: 'secret',
        partitioned: true,
      },
      {
        domain: 'example.com',
        path: '/',
        name: 'string-boolean',
        value: 'secret',
        secure: 'true',
      },
      {
        domain: 'example.com',
        path: '/',
        name: '__Secure-invalid',
        value: 'secret',
      },
      {
        domain: '.example.com',
        hostOnly: false,
        path: '/',
        name: '__Host-invalid',
        value: 'secret',
        secure: true,
      },
      {
        url: 'https://example.com',
        hostOnly: true,
        path: '/',
        name: '__Host-valid',
        value: 'private-value',
        secure: true,
      },
    ]),
  );
  const writes = [];

  const plan = await createBrowserCookieImportPlan({
    filePath,
    now: () => NOW_MS,
  });
  assert.equal(plan.preview.importCount, 1);
  assert.equal(plan.preview.skippedCount, 6);
  assert.doesNotMatch(JSON.stringify(plan), /private-value|__Host-valid/);

  await commitBrowserCookieImport(plan, {
    cookieStore: { set: async (cookie) => writes.push(cookie) },
  });
  assert.equal(writes[0].name, '__Host-valid');
  assert.equal(writes[0].domain, undefined);
});

test('planning rejects exports with no valid cookies', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([
      { url: 'file:///tmp/private', name: 'local', value: 'secret' },
      {
        domain: 'expired.example',
        name: 'expired',
        value: 'secret',
        expirationDate: NOW_MS / 1_000 - 1,
      },
    ]),
  );

  await assert.rejects(
    createBrowserCookieImportPlan({
      filePath,
      now: () => NOW_MS,
    }),
    /no valid, unexpired cookies/,
  );
});

test('replacement count stays unavailable when cookie lookup fails', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([{ domain: 'example.com', name: 'sid', value: 'private' }]),
  );
  let writeCount = 0;

  const plan = await createBrowserCookieImportPlan({
    filePath,
    cookieStore: {
      get: async () => {
        throw new Error('lookup unavailable');
      },
      set: async () => {
        writeCount += 1;
      },
    },
    now: () => NOW_MS,
  });

  assert.equal(plan.preview.replacementCount, null);
  assert.equal(writeCount, 0);
});

test('partial commits report secret-free counts, attempt remaining writes, and consume the plan', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([
      { domain: 'a.example', name: 'first', value: 'first-secret' },
      { domain: 'b.example', name: 'second', value: 'second-secret' },
      { domain: 'c.example', name: 'third', value: 'third-secret' },
    ]),
  );
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
  const plan = await createBrowserCookieImportPlan({
    filePath,
    cookieStore,
    now: () => NOW_MS,
  });
  assert.equal(plan.preview.replacementCount, 2);

  let error;
  try {
    await commitBrowserCookieImport(plan, { cookieStore });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof BrowserCookieImportCommitError);
  assert.equal(error.code, 'BROWSER_COOKIE_IMPORT_PARTIAL');
  assert.deepEqual(error.result, {
    source: 'chrome',
    profileLabel: 'Chrome export',
    importedCount: 2,
    failedCount: 1,
    skippedCount: 0,
    replacementCount: 1,
    domainCount: 2,
    affectedDomains: ['a.example', 'c.example'],
  });
  assert.deepEqual(attemptedNames, ['first', 'second', 'third']);
  assert.doesNotMatch(
    JSON.stringify({ message: error.message, code: error.code, result: error.result }),
    /first|second|third|secret/,
  );

  await assert.rejects(
    commitBrowserCookieImport(plan, { cookieStore }),
    /invalid, expired, or already used/,
  );
  assert.deepEqual(attemptedNames, ['first', 'second', 'third']);
});

test('discard destroys an uncommitted plan', async (t) => {
  const filePath = await writeExport(
    t,
    JSON.stringify([{ domain: 'example.com', name: 'sid', value: 'private' }]),
  );
  let writeCount = 0;
  const cookieStore = {
    set: async () => {
      writeCount += 1;
    },
  };
  const plan = await createBrowserCookieImportPlan({
    filePath,
    now: () => NOW_MS,
  });

  assert.equal(discardBrowserCookieImportPlan(plan), true);
  assert.equal(discardBrowserCookieImportPlan(plan), false);
  await assert.rejects(
    commitBrowserCookieImport(plan, { cookieStore }),
    /invalid, expired, or already used/,
  );
  assert.equal(writeCount, 0);
});

test('planning rejects obsolete browser source fields before reading a file', async () => {
  await assert.rejects(
    createBrowserCookieImportPlan({ source: 'safari', filePath: '/unused' }),
    /source is fixed to Chrome/,
  );
});

test('planning enforces row and file size limits', async (t) => {
  const oversizedRowsPath = await writeExport(
    t,
    JSON.stringify(
      Array.from({ length: 5_001 }, (_, index) => ({
        domain: 'example.com',
        name: `cookie-${index}`,
        value: 'value',
      })),
    ),
    'too-many.json',
  );
  const oversizedFilePath = await writeExport(
    t,
    Buffer.alloc(COOKIE_EXPORT_LIMIT_BYTES + 1, 0x20),
    'too-large.txt',
  );

  await assert.rejects(
    createBrowserCookieImportPlan({ filePath: oversizedRowsPath }),
    /more than 5000 cookies/,
  );
  await assert.rejects(
    createBrowserCookieImportPlan({ filePath: oversizedFilePath }),
    /maximum supported size is 10 MB/,
  );
});

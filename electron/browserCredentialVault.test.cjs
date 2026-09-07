const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createBrowserCredentialVault,
  secureCredentialOrigin,
} = require('./browserCredentialVault.cjs');

function protectedStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (value) => ({
      result: value.toString('utf8'),
      shouldReEncrypt: false,
    }),
    isEncryptionAvailable: () => {
      throw new Error('synchronous safeStorage must not run');
    },
    encryptString: () => {
      throw new Error('synchronous safeStorage must not run');
    },
    decryptString: () => {
      throw new Error('synchronous safeStorage must not run');
    },
  };
}

async function withVault(run, options = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'droidex-browser-vault-'));
  const prompts = [];
  const responses = [...(options.responses || [])];
  const vault = createBrowserCredentialVault({
    appName: 'DROIDEX',
    userDataPath,
    platform: options.platform || 'darwin',
    safeStorage: options.safeStorage || protectedStorage(),
    systemPreferences: options.systemPreferences || {
      canPromptTouchID: () => false,
      promptTouchID: async () => undefined,
    },
    showMessageBox:
      options.showMessageBox ??
      (async (prompt) => {
        prompts.push(prompt);
        return { response: responses.shift() ?? 1 };
      }),
  });
  try {
    await run({ vault, prompts, userDataPath });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('saved logins require HTTPS except explicit loopback development origins', () => {
  assert.equal(
    secureCredentialOrigin('https://accounts.example.com/login'),
    'https://accounts.example.com',
  );
  assert.equal(secureCredentialOrigin('http://localhost:3000/login'), 'http://localhost:3000');
  assert.throws(() => secureCredentialOrigin('http://example.com/login'), /require HTTPS/);
});

test('credential capture keeps one prompt and revalidates before saving', async () => {
  await withVault(
    async ({ vault, prompts }) => {
      const first = vault.capture({
        url: 'https://example.com/login',
        username: 'user@example.com',
        password: 'secret',
        isStillValid: () => false,
      });
      const overlapping = await vault.capture({
        url: 'https://example.com/login',
        username: 'other@example.com',
        password: 'other-secret',
      });
      assert.equal(overlapping, false);
      assert.equal(await first, false);
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].defaultId, 1);
      assert.deepEqual(await vault.origins(), []);
    },
    { responses: [0] },
  );
});

test('saved credential use requires an explicit prompt and never returns data after denial', async () => {
  await withVault(
    async ({ vault, prompts }) => {
      assert.equal(
        await vault.capture({
          url: 'https://example.com/login',
          username: 'user@example.com',
          password: 'secret',
        }),
        true,
      );
      await assert.rejects(vault.credentialForAgent('https://example.com/login'), /denied/);
      assert.equal(prompts[1].defaultId, 1);
      assert.deepEqual(await vault.origins(), ['https://example.com']);
    },
    { responses: [0, 1] },
  );
});

test('deleting a saved login while approval is open revokes the pending use', async () => {
  const approval = deferred();
  const usePromptShown = deferred();
  await withVault(
    async ({ vault }) => {
      assert.equal(
        await vault.capture({
          url: 'https://example.com/login',
          username: 'user@example.com',
          password: 'secret',
        }),
        true,
      );
      const pendingUse = vault.credentialForAgent('https://example.com/login');
      await usePromptShown.promise;
      await vault.delete('https://example.com');
      approval.resolve({ response: 0 });

      await assert.rejects(pendingUse, /No saved login/);
    },
    {
      showMessageBox: async (prompt) => {
        if (prompt.title.startsWith('Save login')) return { response: 0 };
        usePromptShown.resolve();
        return approval.promise;
      },
    },
  );
});

test('credential decryption is serialized against saved-login deletion', async (t) => {
  const decryptStarted = deferred();
  const finishDecrypt = deferred();
  const safeStorage = {
    ...protectedStorage(),
    decryptStringAsync: async (value) => {
      decryptStarted.resolve();
      await finishDecrypt.promise;
      return {
        result: value.toString('utf8'),
        shouldReEncrypt: false,
      };
    },
  };
  await withVault(
    async ({ vault }) => {
      await vault.capture({
        url: 'https://example.com/login',
        username: 'user@example.com',
        password: 'secret',
      });
      const pendingUse = vault.credentialForAgent('https://example.com/login');
      await decryptStarted.promise;

      const originalReadFile = fs.readFile;
      let deletionReadStarted = false;
      fs.readFile = (...args) => {
        deletionReadStarted = true;
        return originalReadFile(...args);
      };
      t.after(() => {
        fs.readFile = originalReadFile;
      });
      const deletion = vault.delete('https://example.com');
      let credential;
      try {
        await Promise.resolve();
        assert.equal(deletionReadStarted, false);
      } finally {
        fs.readFile = originalReadFile;
        finishDecrypt.resolve();
        credential = await pendingUse;
        await deletion;
      }
      assert.deepEqual(credential, {
        username: 'user@example.com',
        password: 'secret',
      });
      assert.deepEqual(await vault.origins(), []);
    },
    { responses: [0, 0], safeStorage },
  );
});

test('saved login storage uses only non-blocking operating-system encryption', async () => {
  await withVault(
    async ({ vault }) => {
      assert.equal(await vault.isAvailable(), true);
      assert.equal(
        await vault.capture({
          url: 'https://example.com/login',
          username: 'user@example.com',
          password: 'secret',
        }),
        true,
      );
      assert.deepEqual(await vault.read('https://example.com'), {
        username: 'user@example.com',
        password: 'secret',
      });
    },
    { platform: 'linux', responses: [0] },
  );
});

test('saved login storage fails closed when async operating-system encryption is unavailable', async () => {
  await withVault(
    async ({ vault, prompts }) => {
      assert.equal(await vault.isAvailable(), false);
      assert.equal(
        await vault.capture({
          url: 'https://example.com/login',
          username: 'user@example.com',
          password: 'secret',
        }),
        false,
      );
      assert.deepEqual(prompts, []);
    },
    {
      safeStorage: {
        ...protectedStorage(),
        isAsyncEncryptionAvailable: async () => false,
      },
    },
  );
});

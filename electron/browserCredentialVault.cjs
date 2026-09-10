const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  isLoopbackHost,
  isParsableUrl,
  MAX_BROWSER_URL_LENGTH,
  parseSafeHttpUrl,
} = require('./nativeBrowserUrls.cjs');

function createBrowserCredentialVault(options) {
  return new BrowserCredentialVault(options);
}

class BrowserCredentialVault {
  constructor(options) {
    this.options = options;
    this.filePath = path.join(options.userDataPath, 'browser-credentials.enc');
    this.writeQueue = Promise.resolve();
    this.promptActive = false;
  }

  async isAvailable() {
    try {
      return (await this.options.safeStorage.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  }

  touchIdAvailable() {
    if (this.options.platform !== 'darwin') return false;
    try {
      return this.options.systemPreferences?.canPromptTouchID() === true;
    } catch {
      return false;
    }
  }

  async origins() {
    return (await readRows(this.filePath)).map((row) => row.origin).sort();
  }

  async capture({ url, username, password, isStillValid = () => true }) {
    const origin = secureCredentialOrigin(url);
    if (typeof username !== 'string' || username.length > 512) return false;
    if (typeof password !== 'string' || !password || password.length > 4_096) return false;
    if (!(await this.isAvailable()) || this.promptActive) return false;
    this.promptActive = true;
    try {
      const existing = await this.read(origin).catch(() => undefined);
      if (existing?.username === username && existing.password === password) return false;
      const response = await this.options.showMessageBox({
        type: 'question',
        buttons: ['Save login', 'Not now'],
        defaultId: 1,
        cancelId: 1,
        title: `Save login in ${this.options.appName}?`,
        message: `Save this login for ${origin}?`,
        detail:
          'The login is encrypted with the operating system credential store. DROIDEX can request a consent-gated fill but never receives the password.',
      });
      if (response.response !== 0 || !isStillValid()) return false;
      await this.upsert(origin, username, password);
      return true;
    } finally {
      this.promptActive = false;
    }
  }

  async credentialForAgent(url) {
    const origin = secureCredentialOrigin(url);
    if (!(await this.isAvailable()))
      throw new Error('Protected saved-login storage is unavailable.');
    const row = (await readRows(this.filePath)).find((candidate) => candidate.origin === origin);
    if (!row) throw new Error(`No saved login is available for ${origin}.`);
    const response = await this.options.showMessageBox({
      type: 'question',
      buttons: ['Use saved login', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Use saved login?',
      message: `Allow DROIDEX to fill your saved login for ${origin}?`,
      detail:
        'The login is injected directly into this page. Its username and password are never returned to the agent.',
    });
    if (response.response !== 0) throw new Error(`Saved-login use was denied for ${origin}.`);
    await this.promptTouchId(new URL(origin).hostname);
    const credential = await this.read(origin);
    if (!credential) throw new Error(`No saved login is available for ${origin}.`);
    return credential;
  }

  async delete(origin) {
    origin = validateExactOrigin(origin);
    await this.queueWrite((rows) => rows.filter((row) => row.origin !== origin));
  }

  async upsert(origin, username, password) {
    await this.queueStorageOperation(async () => {
      const encrypted = await this.options.safeStorage.encryptStringAsync(
        JSON.stringify({ origin, username, password }),
      );
      const rows = await readRows(this.filePath);
      await writeRows(this.filePath, [
        ...rows.filter((row) => row.origin !== origin),
        { origin, enc: encrypted.toString('base64') },
      ]);
    });
  }

  async read(origin) {
    return this.queueStorageOperation(async () => {
      const rows = await readRows(this.filePath);
      const row = rows.find((candidate) => candidate.origin === origin);
      return row ? await this.decrypt(origin, row, rows) : undefined;
    });
  }

  async decrypt(origin, row, rows) {
    let parsed;
    let shouldReEncrypt;
    try {
      const decrypted = await this.options.safeStorage.decryptStringAsync(
        Buffer.from(row.enc, 'base64'),
      );
      parsed = JSON.parse(decrypted.result);
      shouldReEncrypt = decrypted.shouldReEncrypt;
      if (
        parsed?.origin !== origin ||
        typeof parsed.username !== 'string' ||
        typeof parsed.password !== 'string'
      )
        throw new Error();
    } catch {
      throw new Error(
        `The saved login for ${origin} could not be decrypted. Delete it in Settings > Browser and save it again.`,
      );
    }
    if (shouldReEncrypt) {
      try {
        const encrypted = await this.options.safeStorage.encryptStringAsync(
          JSON.stringify({ origin, username: parsed.username, password: parsed.password }),
        );
        await writeRows(this.filePath, [
          ...rows.filter((candidate) => candidate.origin !== origin),
          { origin, enc: encrypted.toString('base64') },
        ]);
      } catch {
        // A failed refresh keeps the still-valid credential; the next read retries.
      }
    }
    return { username: parsed.username, password: parsed.password };
  }

  queueWrite(update) {
    return this.queueStorageOperation(async () => {
      const rows = update(await readRows(this.filePath));
      await writeRows(this.filePath, rows);
    });
  }

  queueStorageOperation(operation) {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async promptTouchId(hostname) {
    if (!this.touchIdAvailable()) return;
    try {
      await this.options.systemPreferences.promptTouchID(`Use the saved login for ${hostname}`);
    } catch {
      throw new Error('Touch ID confirmation was canceled.');
    }
  }
}

function secureCredentialOrigin(value) {
  const origin = exactHttpOrigin(value);
  const url = new URL(origin);
  if (url.protocol === 'https:' || isLoopbackHost(url.hostname)) return origin;
  throw new Error('Saved logins require HTTPS. Plain HTTP is allowed only for local development.');
}

function validateExactOrigin(value) {
  const origin = exactHttpOrigin(value);
  if (origin !== value) throw new Error('Saved login site must be an exact origin.');
  return origin;
}

function exactHttpOrigin(value) {
  if (!isParsableUrl(value, { maxLength: MAX_BROWSER_URL_LENGTH })) {
    throw new Error('Saved login URL is invalid.');
  }
  const parsed = parseSafeHttpUrl(value, { maxLength: MAX_BROWSER_URL_LENGTH });
  if (!parsed) throw new Error('Saved login URLs must use HTTP(S) without embedded credentials.');
  return parsed.origin;
}

async function readRows(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Saved login storage is invalid. Clear it in Settings > Browser.');
  }
  if (!Array.isArray(parsed) || parsed.length > 500)
    throw new Error('Saved login storage is invalid. Clear it in Settings > Browser.');
  for (const row of parsed) {
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).some((key) => key !== 'origin' && key !== 'enc') ||
      typeof row.enc !== 'string' ||
      row.enc.length > 32_768
    ) {
      throw new Error('Saved login storage is invalid. Clear it in Settings > Browser.');
    }
    validateExactOrigin(row.origin);
  }
  return parsed;
}

async function writeRows(filePath, rows) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(rows, null, 2), { mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
}

module.exports = { createBrowserCredentialVault, secureCredentialOrigin };

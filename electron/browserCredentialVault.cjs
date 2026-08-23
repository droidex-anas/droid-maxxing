const fsp = require('node:fs/promises');
const path = require('node:path');

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
      const existing = await this.read(origin);
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
    return this.decrypt(origin, row);
  }

  async delete(origin) {
    origin = validateExactOrigin(origin);
    await this.queueWrite((rows) => rows.filter((row) => row.origin !== origin));
  }

  async upsert(origin, username, password) {
    const encrypted = await this.options.safeStorage.encryptStringAsync(
      JSON.stringify({ username, password }),
    );
    const enc = encrypted.toString('base64');
    await this.queueWrite((rows) => [
      ...rows.filter((row) => row.origin !== origin),
      { origin, enc },
    ]);
  }

  async read(origin) {
    const row = (await readRows(this.filePath)).find((candidate) => candidate.origin === origin);
    return row ? await this.decrypt(origin, row) : undefined;
  }

  async decrypt(origin, row) {
    try {
      const decrypted = await this.options.safeStorage.decryptStringAsync(
        Buffer.from(row.enc, 'base64'),
      );
      const parsed = JSON.parse(decrypted.result);
      if (typeof parsed?.username !== 'string' || typeof parsed?.password !== 'string')
        throw new Error();
      if (decrypted.shouldReEncrypt) await this.upsert(origin, parsed.username, parsed.password);
      return parsed;
    } catch {
      throw new Error(
        `The saved login for ${origin} could not be decrypted. Delete it in Settings > Browser and save it again.`,
      );
    }
  }

  queueWrite(update) {
    const run = this.writeQueue.then(async () => {
      const rows = update(await readRows(this.filePath));
      await writeRows(this.filePath, rows);
    });
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
  if (typeof value !== 'string' || value.length > 8_192)
    throw new Error('Saved login URL is invalid.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Saved login URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Saved login URLs must use HTTP(S) without embedded credentials.');
  }
  return parsed.origin;
}

function isLoopbackHost(hostname) {
  const value = String(hostname).toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
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

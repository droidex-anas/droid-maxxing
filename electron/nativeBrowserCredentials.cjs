const fs = require('node:fs');
const path = require('node:path');

function createNativeBrowserCredentials({ app, appName, safeStorage, dialog, getMainWindow }) {
  const CREDENTIAL_VAULT_FILE = () => path.join(app.getPath('userData'), 'browser-credentials.enc');
  const CREDENTIAL_CONSENT_FILE = () =>
    path.join(app.getPath('userData'), 'browser-credentials.consent');
  let credentialCaptureBusy = false;

  // Saved-login support is strictly opt-in. Until the user agrees the first time
  // they sign in, nothing is captured, auto-filled, or exposed to the agent.
  // 'unset' = never asked, 'enabled' = allowed, 'disabled' = user said never.
  function getCredentialConsent() {
    try {
      const parsed = JSON.parse(fs.readFileSync(CREDENTIAL_CONSENT_FILE(), 'utf8'));
      return parsed && (parsed.consent === 'enabled' || parsed.consent === 'disabled')
        ? parsed.consent
        : 'unset';
    } catch {
      return 'unset';
    }
  }

  function setCredentialConsent(consent) {
    try {
      fs.mkdirSync(path.dirname(CREDENTIAL_CONSENT_FILE()), { recursive: true });
      fs.writeFileSync(CREDENTIAL_CONSENT_FILE(), JSON.stringify({ consent }), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  function loadCredentialVault() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return [];
      const raw = fs.readFileSync(CREDENTIAL_VAULT_FILE(), 'utf8');
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return [];
      return rows.filter(
        (row) => row && typeof row.origin === 'string' && typeof row.enc === 'string',
      );
    } catch {
      return [];
    }
  }

  function saveCredentialVault(rows) {
    fs.mkdirSync(path.dirname(CREDENTIAL_VAULT_FILE()), { recursive: true });
    fs.writeFileSync(CREDENTIAL_VAULT_FILE(), JSON.stringify(rows), { mode: 0o600 });
  }

  function upsertCredential(origin, username, password) {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const enc = safeStorage
      .encryptString(JSON.stringify({ username, password }))
      .toString('base64');
    const rows = loadCredentialVault().filter((row) => row.origin !== origin);
    rows.push({ origin, enc });
    saveCredentialVault(rows);
    return true;
  }

  // Returns the decrypted credential for an origin. Callers must never forward
  // the returned values to the renderer or agent; they are injected in-page only.
  function findCredential(origin) {
    const row = loadCredentialVault().find((entry) => entry.origin === origin);
    if (!row) return undefined;
    try {
      const json = safeStorage.decryptString(Buffer.from(row.enc, 'base64'));
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed.password === 'string') {
        return {
          username: typeof parsed.username === 'string' ? parsed.username : '',
          password: parsed.password,
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function originFor(url) {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }

  async function handleCapture(_senderContents, payload) {
    if (credentialCaptureBusy) return;
    const origin = payload && typeof payload.origin === 'string' ? payload.origin : undefined;
    const password = payload && typeof payload.password === 'string' ? payload.password : '';
    if (!origin || origin === 'null' || !password) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    const consent = getCredentialConsent();
    if (consent === 'disabled') return;
    const existing = findCredential(origin);
    if (
      existing &&
      existing.password === password &&
      existing.username === (payload.username || '')
    )
      return;
    credentialCaptureBusy = true;
    try {
      if (consent === 'unset') {
        // First-time opt-in. The user can enable, skip for now, or never ask.
        const { response } = await dialog.showMessageBox(getMainWindow(), {
          type: 'question',
          buttons: ['Enable & save login', 'Not now', 'Never'],
          defaultId: 0,
          cancelId: 1,
          title: `Save logins in ${appName}?`,
          message: `Let ${appName} securely save logins for its browser?`,
          detail: `Logins are encrypted with your OS keychain so you stay signed in across restarts (${origin}). The agent can use a saved login to sign in for you, but can never read the username or password. You can turn this off anytime by choosing Never.`,
        });
        if (response === 2) {
          setCredentialConsent('disabled');
          return;
        }
        if (response === 1) return; // Not now: ask again on the next sign-in.
        setCredentialConsent('enabled');
        upsertCredential(origin, payload.username || '', password);
        return;
      }
      const { response } = await dialog.showMessageBox(getMainWindow(), {
        type: 'question',
        buttons: ['Save password', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        title: 'Save password',
        message: `Save this login for ${origin}?`,
        detail: `${appName} stores it encrypted with your OS keychain. The agent can use it to sign in but can never read it.`,
      });
      if (response === 0) upsertCredential(origin, payload.username || '', password);
    } catch {
      /* dialog dismissed */
    } finally {
      credentialCaptureBusy = false;
    }
  }

  async function autofill(contents) {
    if (getCredentialConsent() !== 'enabled') return false;
    if (!contents) return false;
    const origin = originFor(contents.getURL());
    if (!origin) return false;
    const credential = findCredential(origin);
    if (!credential) return false;
    try {
      const result = await contents.executeJavaScript(
        `window.__DROIDMAXX_FILL_CREDENTIALS?.(${JSON.stringify(credential)});`,
        true,
      );
      return Boolean(result && result.filled);
    } catch {
      return false;
    }
  }

  // Agent-blind login: the saved secret is decrypted and injected here in the
  // main process. The request and the result never carry the values, and the
  // returned snapshot has password fields redacted by the preload.
  async function fillForAgent(contents, request) {
    if (getCredentialConsent() !== 'enabled') {
      return {
        requestId: request.requestId,
        ok: false,
        error: `Saved logins are turned off for the ${appName} browser. Ask the user to sign in once; they will be prompted to enable and save the login first.`,
      };
    }
    const origin = originFor(contents.getURL());
    const credential = origin ? findCredential(origin) : undefined;
    if (!credential) {
      return {
        requestId: request.requestId,
        ok: false,
        error:
          'No saved credentials for this site. The user can sign in once and choose to save the password.',
      };
    }
    const fill = await contents
      .executeJavaScript(
        `window.__DROIDMAXX_FILL_CREDENTIALS?.(${JSON.stringify(credential)});`,
        true,
      )
      .catch(() => undefined);
    if (!fill || !fill.ok) {
      return {
        requestId: request.requestId,
        ok: false,
        error: (fill && fill.error) || 'Could not find a login form to fill on this page.',
      };
    }
    const probe = await contents
      .executeJavaScript(
        `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({ ...request, action: 'snapshot' })});`,
        true,
      )
      .catch(() => undefined);
    return { requestId: request.requestId, ok: true, snapshot: probe?.snapshot };
  }

  return {
    handleCapture,
    autofill,
    fillForAgent,
  };
}

module.exports = { createNativeBrowserCredentials };

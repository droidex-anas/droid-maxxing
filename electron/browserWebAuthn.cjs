const TEAM_KEYCHAIN_GROUP = /^[A-Z0-9]{10}\.app\.droidex\.webauthn$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,2048}$/;

function createBrowserWebAuthnController(options) {
  return new BrowserWebAuthnController(options);
}

class BrowserWebAuthnController {
  constructor(options) {
    this.options = options;
    this.initialized = false;
    this.state = {
      accountSelectionAvailable: false,
      touchIdPasskeysAvailable: false,
      touchIdPasskeysReason: 'signed_release_required',
    };
  }

  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    const browserSession = this.options.getSession();
    if (typeof browserSession?.on === 'function') {
      browserSession.on('select-webauthn-account', (_event, details, callback) =>
        this.selectAccount(details, callback),
      );
      this.state.accountSelectionAvailable = true;
    }

    if (this.options.platform !== 'darwin') {
      this.state.touchIdPasskeysReason = 'unsupported_platform';
      return;
    }
    if (
      !this.options.isPackaged ||
      !TEAM_KEYCHAIN_GROUP.test(this.options.keychainAccessGroup || '')
    ) {
      this.state.touchIdPasskeysReason = 'signed_release_required';
      return;
    }
    if (typeof this.options.app.configureWebAuthn !== 'function') {
      this.state.touchIdPasskeysReason = 'runtime_unsupported';
      return;
    }
    this.options.app.configureWebAuthn({
      touchID: {
        keychainAccessGroup: this.options.keychainAccessGroup,
        promptReason: 'sign in to $1',
      },
    });
    this.state.touchIdPasskeysAvailable = true;
    this.state.touchIdPasskeysReason = 'available';
  }

  capability() {
    return { ...this.state };
  }

  async selectAccount(details, callback) {
    let selectedCredentialId = null;
    try {
      const request = validateAccountRequest(details);
      if (!request) return;
      const response = await this.options.showMessageBox({
        type: 'question',
        buttons: [...request.accounts.map(accountLabel), 'Cancel'],
        defaultId: request.accounts.length,
        cancelId: request.accounts.length,
        title: 'Choose a passkey account',
        message: `Choose the account to use with ${request.relyingPartyId}.`,
        detail: 'DROIDEX sends only your choice to the operating-system authenticator.',
        noLink: true,
      });
      if (
        response.response >= 0 &&
        response.response < request.accounts.length &&
        isSameAuthoritativeFrame(request)
      ) {
        selectedCredentialId = request.accounts[response.response].credentialId;
      }
    } catch {
      selectedCredentialId = null;
    } finally {
      callback(selectedCredentialId);
    }
  }
}

function validateAccountRequest(details) {
  const frame = details?.frame;
  const relyingPartyId = normalizeRelyingPartyId(details?.relyingPartyId);
  if (!frame || !relyingPartyId || frame.detached || frame.parent !== null) return undefined;
  let frameUrl;
  try {
    frameUrl = new URL(frame.url);
  } catch {
    return undefined;
  }
  if (
    frameUrl.protocol !== 'https:' ||
    !hostnameMatchesRelyingParty(frameUrl.hostname, relyingPartyId) ||
    !Array.isArray(details.accounts) ||
    details.accounts.length === 0 ||
    details.accounts.length > 20
  ) {
    return undefined;
  }
  const accounts = details.accounts.map(normalizeAccount);
  if (accounts.some((account) => !account)) return undefined;
  return {
    accounts,
    relyingPartyId,
    frame,
    frameOrigin: frameUrl.origin,
    processId: frame.processId,
    routingId: frame.routingId,
  };
}

function isSameAuthoritativeFrame(request) {
  try {
    return (
      !request.frame.detached &&
      request.frame.parent === null &&
      request.frame.processId === request.processId &&
      request.frame.routingId === request.routingId &&
      new URL(request.frame.url).origin === request.frameOrigin
    );
  } catch {
    return false;
  }
}

function normalizeAccount(account) {
  if (!account || !CREDENTIAL_ID.test(account.credentialId || '')) return undefined;
  return {
    credentialId: account.credentialId,
    displayName: cleanAccountLabel(account.displayName),
    name: cleanAccountLabel(account.name),
  };
}

function accountLabel(account, index) {
  if (account.displayName && account.name && account.displayName !== account.name) {
    return `${account.displayName} — ${account.name}`;
  }
  return account.displayName || account.name || `Account ${index + 1}`;
}

function cleanAccountLabel(value) {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex -- Account labels must sanitize control bytes before display.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  );
}

function normalizeRelyingPartyId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return undefined;
  const normalized = value.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.includes('..')) return undefined;
  return normalized;
}

function hostnameMatchesRelyingParty(hostname, relyingPartyId) {
  const host = hostname.toLowerCase();
  return host === relyingPartyId || host.endsWith(`.${relyingPartyId}`);
}

module.exports = { createBrowserWebAuthnController };

const {
  authenticationPopupTarget,
  validateAgentAuthenticationIntent,
} = require('./browserAuthenticationIntent.cjs');
const {
  consumeAuthenticationPopup,
  grantAuthenticationPopup,
  hardenAuthenticationPopup,
} = require('./browserAuthenticationPopup.cjs');
const { createCredentialCaptureGuard } = require('./browserCredentialCapture.cjs');

function createNativeBrowserCredentials({
  browserSettings,
  partition,
  safeWebContents,
  now = Date.now,
}) {
  function capture(entry, contents, submittedUrl, payload) {
    const isStillValid = createCredentialCaptureGuard(entry, contents, submittedUrl);
    return browserSettings.captureCredential({
      url: submittedUrl,
      username: payload?.username,
      password: payload?.password,
      kind: payload?.kind,
      isStillValid,
    });
  }

  async function fillForAgent(entry, contents, request) {
    const expectedOrigin = new URL(contents.getURL()).origin;
    const expectedView = entry.view;
    const expectedGeneration = entry.documentGeneration;
    let credential;
    try {
      credential = await browserSettings.credentialForAgent(contents.getURL());
    } catch (error) {
      return {
        requestId: request.requestId,
        ok: false,
        error: error?.message || 'Saved-login use was not authorized.',
      };
    }
    if (entry.canceledRequestId === request.requestId) {
      return {
        requestId: request.requestId,
        ok: false,
        error:
          'The saved-login request was abandoned before approval completed. Nothing was filled.',
      };
    }
    if (!isCurrentDocument(entry, expectedView, contents, expectedGeneration, expectedOrigin)) {
      return {
        requestId: request.requestId,
        ok: false,
        error: 'The page changed while saved-login use was being approved. Nothing was filled.',
      };
    }
    const fill = await contents
      .executeJavaScript(
        `location.origin === ${JSON.stringify(expectedOrigin)}
          ? window.__DROIDMAXX_FILL_CREDENTIALS?.(${JSON.stringify(credential)})
          : ({ ok: false, error: 'The login origin changed before fill.' });`,
        true,
      )
      .catch(() => undefined);
    if (!isCurrentDocument(entry, expectedView, contents, expectedGeneration, expectedOrigin)) {
      return {
        requestId: request.requestId,
        ok: false,
        error: 'The page changed while the saved login was being filled.',
      };
    }
    if (!fill?.ok) {
      return {
        requestId: request.requestId,
        ok: false,
        error: fill?.error || 'Could not find a login form to fill on this page.',
      };
    }
    entry.networkEvents.length = 0;
    entry.consoleEvents.length = 0;
    const probe = await contents
      .executeJavaScript(
        `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
          ...request,
          action: 'snapshot',
        })});`,
        true,
      )
      .catch(() => undefined);
    return { requestId: request.requestId, ok: true, snapshot: probe?.snapshot };
  }

  async function authorizeAuthentication(entry, contents, request) {
    const isEnter = request.action === 'keypress' && request.key === 'Enter';
    if (request.action !== 'click' && !isEnter) return;
    const expectedView = entry.view;
    const expectedGeneration = entry.documentGeneration;
    const inspect = () =>
      contents.executeJavaScript(
        `window.__DROIDMAXX_AUTH_INTENT?.(${JSON.stringify(request)});`,
        true,
      );
    const inspectedIntent = await inspect();
    if (!inspectedIntent) return;
    const intent = validateAgentAuthenticationIntent(inspectedIntent, contents.getURL());
    const popupTarget = authenticationPopupTarget(intent);
    await browserSettings.authorizeAuthenticationAction(intent);
    if (!isCurrentDocument(entry, expectedView, contents, expectedGeneration, intent.origin)) {
      throw new Error('The page changed while authentication was being approved.');
    }
    const confirmed = await inspect();
    if (!confirmed) {
      throw new Error('The authentication control changed while approval was open.');
    }
    const confirmedIntent = validateAgentAuthenticationIntent(confirmed, contents.getURL());
    if (
      confirmedIntent.kind !== intent.kind ||
      confirmedIntent.origin !== intent.origin ||
      confirmedIntent.targetUrl !== intent.targetUrl
    ) {
      throw new Error('The authentication control changed while approval was open.');
    }
    if (popupTarget) grantAuthenticationPopup(entry, expectedView, popupTarget, now());
  }

  function isCurrentDocument(entry, view, contents, documentGeneration, origin) {
    try {
      return (
        entry.view === view &&
        entry.documentGeneration === documentGeneration &&
        safeWebContents(view) === contents &&
        !contents.isDestroyed() &&
        new URL(contents.getURL()).origin === origin
      );
    } catch {
      return false;
    }
  }

  function allowAuthenticationPopup(entry, view, url) {
    return consumeAuthenticationPopup(entry, view, url, partition, now());
  }

  function invalidate(entry) {
    entry.authenticationPopupCapability = null;
  }

  return {
    allowAuthenticationPopup,
    authorizeAuthentication,
    capture,
    fillForAgent,
    hardenAuthenticationPopup,
    invalidate,
  };
}

module.exports = { createNativeBrowserCredentials };

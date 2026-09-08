const {
  MAX_BROWSER_URL_LENGTH,
  isParsableUrl,
  parseSafeHttpUrl,
} = require('./nativeBrowserUrls.cjs');

const AUTHENTICATION_KINDS = new Set(['signup', 'signin', 'oauth', 'passkey']);

function validateAgentAuthenticationIntent(intent, currentUrl) {
  if (intent?.kind === 'cross_origin_frame') {
    throw new Error('Cross-origin frame authentication is blocked in DROIDEX Browser.');
  }
  if (!AUTHENTICATION_KINDS.has(intent?.kind)) {
    throw new Error('Unknown browser authentication action.');
  }
  const currentOrigin = exactHttpOrigin(currentUrl);
  if (intent.origin !== currentOrigin) throw new Error('Authentication action origin changed.');
  return {
    kind: intent.kind,
    origin: currentOrigin,
    label: typeof intent.label === 'string' ? intent.label : '',
    targetUrl: intent.targetUrl === undefined ? undefined : exactHttpUrl(intent.targetUrl),
  };
}

function authenticationPopupTarget(intent) {
  if (intent.kind !== 'oauth') return undefined;
  if (!intent.targetUrl) {
    throw new Error('The OAuth popup destination could not be verified, so it was blocked.');
  }
  return intent.targetUrl;
}

function exactHttpOrigin(value) {
  return new URL(exactHttpUrl(value)).origin;
}

function exactHttpUrl(value) {
  if (!isParsableUrl(value, { maxLength: MAX_BROWSER_URL_LENGTH })) {
    throw new Error('Authentication destination is invalid.');
  }
  const parsed = parseSafeHttpUrl(value, { maxLength: MAX_BROWSER_URL_LENGTH });
  if (!parsed) {
    throw new Error('Authentication destination must use HTTP(S) without embedded credentials.');
  }
  return parsed.href;
}

module.exports = { authenticationPopupTarget, validateAgentAuthenticationIntent };

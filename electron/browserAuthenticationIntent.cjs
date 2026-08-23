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
  if (typeof value !== 'string' || value.length > 8_192) {
    throw new Error('Authentication destination is invalid.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Authentication destination is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Authentication destination must use HTTP(S) without embedded credentials.');
  }
  return parsed.href;
}

module.exports = { authenticationPopupTarget, validateAgentAuthenticationIntent };

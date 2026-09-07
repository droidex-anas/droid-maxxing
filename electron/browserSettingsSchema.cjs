const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  BROWSER_AGENT_CURSOR_DEFAULT_SIZE,
  BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
  BROWSER_AGENT_CURSOR_STYLES,
  validateBrowserAgentCursorSize,
} = require('./browserAgentCursor.cjs');

const SETTINGS_VERSION = 3;
const COOKIE_IMPORT_METHODS = new Set(['file', 'profile']);
const AGENT_CURSOR_STYLES = new Set(BROWSER_AGENT_CURSOR_STYLES);
const NAVIGATION_APPROVALS = new Set(['follow_autonomy', 'always_ask', 'new_sites', 'never_ask']);
const LOGIN_FILL_APPROVALS = new Set(['always_ask', 'never']);
const SITE_PERMISSION_MODES = new Set(['block', 'ask']);
const AGENT_ACTIONS = new Set([
  'open',
  'snapshot',
  'reload',
  'goBack',
  'goForward',
  'click',
  'hover',
  'selectOption',
  'type',
  'keypress',
  'scroll',
  'resize',
  'inspect',
  'network',
  'console',
  'capture',
  'close',
  'fillCredentials',
]);

function createDefaultBrowserSettings(downloadDirectory) {
  return {
    version: SETTINGS_VERSION,
    agentAccessEnabled: true,
    navigationApproval: 'follow_autonomy',
    loginFillApproval: 'always_ask',
    diagnosticsEnabled: false,
    sitePermissionMode: 'block',
    askDownloadLocation: true,
    showAgentCursor: true,
    agentCursorStyle: BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
    agentCursorSize: BROWSER_AGENT_CURSOR_DEFAULT_SIZE,
    homePage: 'https://www.google.com/',
    downloadDirectory,
    approvedAgentOrigins: [],
    sitePermissions: [],
    lastCookieImport: null,
  };
}

async function readSettings(filePath, defaults) {
  try {
    return validateSettings(JSON.parse(await fsp.readFile(filePath, 'utf8')), defaults);
  } catch (error) {
    if (error?.code === 'ENOENT') return defaults;
    if (error?.message?.startsWith('Invalid browser settings:')) throw error;
    throw new Error('Invalid browser settings: the settings file is not valid JSON.');
  }
}

function validateSettings(value, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid browser settings: expected an object.');
  }
  const keys = Object.keys(defaults);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Invalid browser settings: contains an unknown setting.');
  }
  if (value.version !== SETTINGS_VERSION) {
    throw new Error('Invalid browser settings: unsupported version.');
  }
  return {
    ...validateSettingsPatch(value, true),
    version: SETTINGS_VERSION,
    downloadDirectory: validateAbsoluteDirectory(value.downloadDirectory),
    approvedAgentOrigins: validateOriginList(value.approvedAgentOrigins),
    sitePermissions: validateSitePermissions(value.sitePermissions),
    lastCookieImport: validateCookieImportReceipt(value.lastCookieImport),
  };
}

function createCookieImportReceipt(value, nowMs = Date.now()) {
  let importedAt;
  try {
    importedAt = new Date(nowMs).toISOString();
  } catch {
    throw new Error('Invalid browser settings: cookie import timestamp is invalid.');
  }
  return validateCookieImportReceipt({ ...value, importedAt });
}

function validateCookieImportReceipt(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid browser settings: cookie import receipt must be an object or null.');
  }
  const allowed = [
    'importedAt',
    'source',
    'importMethod',
    'profileLabel',
    'importedCount',
    'replacementCount',
    'skippedCount',
    'failedCount',
    'domainCount',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('Invalid browser settings: cookie import receipt contains an unknown field.');
  }
  if (typeof value.importedAt !== 'string' || value.importedAt.length > 32) {
    throw new Error('Invalid browser settings: cookie import timestamp is invalid.');
  }
  const importedAt = new Date(value.importedAt);
  if (!Number.isFinite(importedAt.valueOf()) || importedAt.toISOString() !== value.importedAt) {
    throw new Error('Invalid browser settings: cookie import timestamp is invalid.');
  }
  if (value.source !== 'chrome') {
    throw new Error('Invalid browser settings: cookie import source is invalid.');
  }
  if (!COOKIE_IMPORT_METHODS.has(value.importMethod)) {
    throw new Error('Invalid browser settings: cookie import method is invalid.');
  }
  if (
    typeof value.profileLabel !== 'string' ||
    !value.profileLabel.trim() ||
    value.profileLabel.length > 80 ||
    // eslint-disable-next-line no-control-regex -- Persisted profile labels must reject control bytes.
    /[\u0000-\u001f\u007f]/.test(value.profileLabel)
  ) {
    throw new Error('Invalid browser settings: cookie import profile label is invalid.');
  }
  const importedCount = validateCookieImportCount(value.importedCount, 'imported');
  const replacementCount =
    value.replacementCount === null
      ? null
      : validateCookieImportCount(value.replacementCount, 'replacement');
  const skippedCount = validateCookieImportCount(value.skippedCount, 'skipped');
  const failedCount = validateCookieImportCount(value.failedCount, 'failed');
  const domainCount = validateCookieImportCount(value.domainCount, 'domain');
  if (importedCount + failedCount + skippedCount > 5_000) {
    throw new Error('Invalid browser settings: cookie import total count is invalid.');
  }
  if (replacementCount !== null && replacementCount > importedCount) {
    throw new Error('Invalid browser settings: cookie import replacement count is invalid.');
  }
  if (domainCount > importedCount) {
    throw new Error('Invalid browser settings: cookie import domain count is invalid.');
  }
  return {
    importedAt: value.importedAt,
    source: 'chrome',
    importMethod: value.importMethod,
    profileLabel: value.profileLabel,
    importedCount,
    replacementCount,
    skippedCount,
    failedCount,
    domainCount,
  };
}

function validateCookieImportCount(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 5_000) {
    throw new Error(`Invalid browser settings: cookie import ${label} count is invalid.`);
  }
  return value;
}

function validateSettingsPatch(patch, complete = false) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Browser settings update must be an object.');
  }
  const allowed = new Set([
    'agentAccessEnabled',
    'navigationApproval',
    'loginFillApproval',
    'diagnosticsEnabled',
    'sitePermissionMode',
    'askDownloadLocation',
    'showAgentCursor',
    'agentCursorStyle',
    'agentCursorSize',
    'homePage',
  ]);
  if (!complete && Object.keys(patch).some((key) => !allowed.has(key))) {
    throw new Error('Browser settings update contains an unknown setting.');
  }
  const out = {};
  for (const key of [
    'agentAccessEnabled',
    'diagnosticsEnabled',
    'askDownloadLocation',
    'showAgentCursor',
  ]) {
    if (complete || key in patch) {
      if (typeof patch[key] !== 'boolean') {
        throw new Error(`Browser setting ${key} must be a boolean.`);
      }
      out[key] = patch[key];
    }
  }
  for (const [key, values] of [
    ['navigationApproval', NAVIGATION_APPROVALS],
    ['loginFillApproval', LOGIN_FILL_APPROVALS],
    ['sitePermissionMode', SITE_PERMISSION_MODES],
    ['agentCursorStyle', AGENT_CURSOR_STYLES],
  ]) {
    if (complete || key in patch) {
      if (!values.has(patch[key])) throw new Error(`Browser setting ${key} has an invalid value.`);
      out[key] = patch[key];
    }
  }
  if (complete || 'homePage' in patch) out.homePage = validateHomePage(patch.homePage);
  if (complete || 'agentCursorSize' in patch) {
    try {
      out.agentCursorSize = validateBrowserAgentCursorSize(patch.agentCursorSize);
    } catch {
      throw new Error('Browser setting agentCursorSize must be an integer from 24 to 64 pixels.');
    }
  }
  return out;
}

function validateAgentRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid agent browser request.');
  }
  for (const key of ['requestId', 'appSessionId', 'browserSessionId']) {
    if (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > 256) {
      throw new Error(`Invalid agent browser ${key}.`);
    }
  }
  if (!AGENT_ACTIONS.has(request.action)) throw new Error('Unknown agent browser action.');
  if (request.action === 'open' && typeof request.url !== 'string') {
    throw new Error('Agent browser open requires an http(s) URL.');
  }
  return request.action;
}

function exactHttpOrigin(value) {
  if (typeof value !== 'string' || value.length > 8_192) {
    throw new Error('Agent browser URL is invalid.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Agent browser URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Agent browser URLs must use http(s) without embedded credentials.');
  }
  return parsed.origin;
}

function validateExactOrigin(value) {
  const origin = exactHttpOrigin(value);
  if (origin !== value) throw new Error('Browser site grant must be an exact origin.');
  return origin;
}

function validateOriginList(value) {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error('Invalid browser settings: site grants must be an array.');
  }
  return [...new Set(value.map(validateExactOrigin))];
}

function addExactOrigin(origins, origin) {
  return origins.includes(origin) ? origins : [...origins, origin];
}

function validateSitePermissions(value) {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error('Invalid browser settings: site permissions must be an array.');
  }
  const rules = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Invalid browser settings: site permission must be an object.');
    }
    if (Object.keys(candidate).some((key) => !['origin', 'camera', 'microphone'].includes(key))) {
      throw new Error('Invalid browser settings: site permission contains an unknown value.');
    }
    return {
      origin: validateExactOrigin(candidate.origin),
      camera: validateSiteDecision(candidate.camera),
      microphone: validateSiteDecision(candidate.microphone),
    };
  });
  if (new Set(rules.map(({ origin }) => origin)).size !== rules.length) {
    throw new Error('Invalid browser settings: site permission origins must be unique.');
  }
  return rules;
}

function validateSiteDecision(value) {
  if (!['allow', 'ask', 'deny'].includes(value)) {
    throw new Error('Invalid browser settings: site permission decision is invalid.');
  }
  return value;
}

function updateSitePermissions(rules, { origin, mediaTypes, decision }) {
  origin = validateExactOrigin(origin);
  decision = validateSiteDecision(decision);
  const existing = rules.find((candidate) => candidate.origin === origin);
  const next = existing ? { ...existing } : { origin, camera: 'ask', microphone: 'ask' };
  next.camera = mediaTypes.includes('video') ? decision : next.camera;
  next.microphone = mediaTypes.includes('audio') ? decision : next.microphone;
  return next.camera === 'ask' && next.microphone === 'ask'
    ? rules.filter((candidate) => candidate.origin !== origin)
    : [...rules.filter((candidate) => candidate.origin !== origin), next];
}

function effectiveNavigationApproval(configured, autonomy) {
  if (configured !== 'follow_autonomy') return configured;
  if (autonomy === 'high') return 'never_ask';
  if (autonomy === 'medium') return 'new_sites';
  return 'always_ask';
}

function validateHomePage(value) {
  exactHttpOrigin(value);
  const url = new URL(value);
  if (url.href.length > 2_048) throw new Error('Browser home page is too long.');
  return url.href;
}

function weakensBrowserProtection(current, patch) {
  const navigationApprovalWeakens =
    (current.navigationApproval === 'always_ask' &&
      ['new_sites', 'follow_autonomy', 'never_ask'].includes(patch.navigationApproval)) ||
    (current.navigationApproval === 'new_sites' &&
      ['follow_autonomy', 'never_ask'].includes(patch.navigationApproval)) ||
    (patch.navigationApproval === 'never_ask' && current.navigationApproval !== 'never_ask');
  return (
    (patch.agentAccessEnabled === true && !current.agentAccessEnabled) ||
    (patch.diagnosticsEnabled === true && !current.diagnosticsEnabled) ||
    navigationApprovalWeakens ||
    (patch.loginFillApproval === 'always_ask' && current.loginFillApproval === 'never') ||
    (patch.sitePermissionMode === 'ask' && current.sitePermissionMode === 'block') ||
    (patch.askDownloadLocation === false && current.askDownloadLocation)
  );
}

async function writeSettings(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
}

function validateAbsoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('Invalid browser settings: download directory must be absolute.');
  }
  return path.resolve(value);
}

module.exports = {
  addExactOrigin,
  createCookieImportReceipt,
  createDefaultBrowserSettings,
  effectiveNavigationApproval,
  exactHttpOrigin,
  readSettings,
  updateSitePermissions,
  validateAgentRequest,
  validateExactOrigin,
  validateSettings,
  validateSettingsPatch,
  weakensBrowserProtection,
  writeSettings,
};

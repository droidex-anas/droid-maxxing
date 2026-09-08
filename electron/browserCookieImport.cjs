const fs = require('node:fs/promises');
const { parseSafeHttpUrl } = require('./nativeBrowserUrls.cjs');

const COOKIE_EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;
const COOKIE_EXPORT_LIMIT_ROWS = 5_000;
const COOKIE_LIMIT_BYTES = 4_096;
const COOKIE_WRITE_CONCURRENCY = 8;
const PLAN_SECRETS = new WeakMap();

// File and profile imports report the same failure shape under their own error
// name, code prefix, and partial wording.
const FILE_COOKIE_IMPORT_COMMIT = Object.freeze({
  name: 'BrowserCookieImportCommitError',
  codePrefix: 'BROWSER_COOKIE_IMPORT',
  partialPhrase: 'stopped with',
});
const PROFILE_COOKIE_IMPORT_COMMIT = Object.freeze({
  name: 'BrowserProfileCookieImportCommitError',
  codePrefix: 'BROWSER_PROFILE_COOKIE_IMPORT',
  partialPhrase: 'completed partially:',
});

class BrowserCookieImportCommitError extends Error {
  constructor(result, variant = FILE_COOKIE_IMPORT_COMMIT) {
    const partial = result.importedCount > 0;
    super(
      partial
        ? `Cookie import ${variant.partialPhrase} ${result.importedCount} stored and ${result.failedCount} failed.`
        : `Cookie import failed for ${result.failedCount} cookies.`,
    );
    this.name = variant.name;
    this.code = `${variant.codePrefix}_${partial ? 'PARTIAL' : 'FAILED'}`;
    this.result = result;
  }
}

async function createBrowserCookieImportPlan(options) {
  if (!options || typeof options !== 'object')
    throw new Error('Cookie import options are invalid.');
  if (Object.hasOwn(options, 'source')) {
    throw new Error('Cookie import source is fixed to Chrome. Remove the obsolete source field.');
  }
  const { filePath, cookieStore, now = Date.now } = options;
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Select a cookie export file.');
    if (stat.size > COOKIE_EXPORT_LIMIT_BYTES) {
      throw new Error('Cookie export is too large. The maximum supported size is 10 MB.');
    }

    const parsed = parseCookieExport(await readBoundedExport(file), now());
    if (parsed.cookies.length === 0) {
      throw new Error('Cookie export contains no valid, unexpired cookies to import.');
    }
    const affectedDomains = Object.freeze([...new Set(parsed.cookies.map(cookieHostname))].sort());
    const replacementKeys = await findReplacementKeys(cookieStore, parsed.cookies);
    const replacementCount = replacementKeys?.size ?? null;
    const preview = Object.freeze({
      source: 'chrome',
      profileLabel: 'Chrome export',
      importCount: parsed.cookies.length,
      skippedCount: parsed.skippedCount,
      replacementCount,
      domainCount: affectedDomains.length,
      affectedDomains,
    });
    const plan = Object.freeze({ preview });
    PLAN_SECRETS.set(plan, { cookies: parsed.cookies, replacementKeys });
    return plan;
  } finally {
    await file.close();
  }
}

async function readBoundedExport(file) {
  const buffer = Buffer.allocUnsafe(COOKIE_EXPORT_LIMIT_BYTES + 1);
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > COOKIE_EXPORT_LIMIT_BYTES) {
      throw new Error('Cookie export is too large. The maximum supported size is 10 MB.');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    buffer.fill(0);
  }
}

async function commitBrowserCookieImport(plan, { cookieStore }) {
  assertCookieStore(cookieStore);
  const secret = PLAN_SECRETS.get(plan);
  if (!secret) throw new Error('Cookie import plan is invalid, expired, or already used.');

  // A plan is a single-use capability. Consume it before the first asynchronous
  // write so concurrent commits cannot replay bearer cookies.
  PLAN_SECRETS.delete(plan);
  let committed;
  try {
    committed = await commitCookieBatch(secret.cookies, {
      cookieKey,
      domain: cookieHostname,
      replacementKeys: secret.replacementKeys,
      write: (cookie) => cookieStore.set(cookie),
    });
  } finally {
    // Drop the module's final strong references whether the store succeeds,
    // rejects, or throws synchronously.
    secret.cookies.length = 0;
    secret.replacementKeys?.clear();
  }

  const result = Object.freeze({
    source: plan.preview.source,
    profileLabel: plan.preview.profileLabel,
    importedCount: committed.importedCount,
    failedCount: committed.failedCount,
    skippedCount: plan.preview.skippedCount,
    replacementCount: committed.replacementCount,
    domainCount: committed.domainCount,
    affectedDomains: committed.affectedDomains,
  });
  if (committed.failedCount > 0) throw new BrowserCookieImportCommitError(result);
  return result;
}

async function commitCookieBatch(
  items,
  { cookieKey: itemKey, dispose = () => {}, domain, replacementKeys, write },
) {
  let nextIndex = 0;
  let importedCount = 0;
  let failedCount = 0;
  let replacementCount = replacementKeys === null ? null : 0;
  const affectedDomains = new Set();

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      try {
        await write(item);
        importedCount += 1;
        if (replacementKeys?.has(itemKey(item))) replacementCount += 1;
        affectedDomains.add(domain(item));
      } catch {
        failedCount += 1;
      } finally {
        dispose(item);
      }
    }
  }

  const workerCount = Math.min(COOKIE_WRITE_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return Object.freeze({
    importedCount,
    failedCount,
    replacementCount,
    domainCount: affectedDomains.size,
    affectedDomains: Object.freeze([...affectedDomains].sort()),
  });
}

function discardBrowserCookieImportPlan(plan) {
  const secret = PLAN_SECRETS.get(plan);
  if (!secret) return false;
  secret.cookies.length = 0;
  secret.replacementKeys?.clear();
  PLAN_SECRETS.delete(plan);
  return true;
}

async function findReplacementKeys(cookieStore, cookies) {
  if (!cookieStore || typeof cookieStore.get !== 'function') return null;
  try {
    const existing = await cookieStore.get({});
    if (!Array.isArray(existing)) return null;
    const existingKeys = new Set(
      existing
        .filter((cookie) => !cookie?.partitionKey)
        .map(cookieKey)
        .filter(Boolean),
    );
    return new Set(cookies.map(cookieKey).filter((key) => existingKeys.has(key)));
  } catch {
    return null;
  }
}

function parseCookieExport(text, nowMs = Date.now()) {
  if (typeof text !== 'string') throw new Error('Cookie export must be text.');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Cookie export is empty.');
  const rows =
    trimmed.startsWith('{') || trimmed.startsWith('[')
      ? parseJsonRows(trimmed)
      : parseNetscapeRows(trimmed);
  if (rows.length > COOKIE_EXPORT_LIMIT_ROWS) {
    throw new Error(`Cookie export contains more than ${COOKIE_EXPORT_LIMIT_ROWS} cookies.`);
  }

  const cookiesByKey = new Map();
  let skippedCount = 0;
  for (const row of rows) {
    const cookie = normalizeCookie(row, nowMs);
    if (!cookie) {
      skippedCount += 1;
      continue;
    }
    const key = cookieKey(cookie);
    if (cookiesByKey.has(key)) skippedCount += 1;
    cookiesByKey.set(key, Object.freeze(cookie));
  }
  return { cookies: [...cookiesByKey.values()], skippedCount };
}

function parseJsonRows(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Cookie export is not valid JSON or Netscape cookie text.');
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(rows)) throw new Error('JSON cookie export must be an array of cookies.');
  return rows;
}

function parseNetscapeRows(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || (rawLine.startsWith('#') && !rawLine.startsWith('#HttpOnly_'))) continue;
    const parts = rawLine.split('\t');
    if (parts.length !== 7) {
      rows.push(null);
      continue;
    }
    const httpOnly = parts[0].startsWith('#HttpOnly_');
    const domain = httpOnly ? parts[0].slice('#HttpOnly_'.length) : parts[0];
    const includeSubdomains = parts[1].toUpperCase();
    const secure = parts[3].toUpperCase();
    if (
      (includeSubdomains !== 'TRUE' && includeSubdomains !== 'FALSE') ||
      (secure !== 'TRUE' && secure !== 'FALSE')
    ) {
      rows.push(null);
      continue;
    }
    rows.push({
      domain,
      hostOnly: includeSubdomains === 'FALSE',
      path: parts[2],
      secure: secure === 'TRUE',
      expirationDate: Number(parts[4]),
      name: parts[5],
      value: parts[6],
      httpOnly,
    });
  }
  return rows;
}

function normalizeCookie(row, nowMs) {
  if (!row || typeof row !== 'object' || hasUnsupportedPartition(row)) return undefined;
  const name = normalizeCookieName(row.name);
  const value = boundedCookieText(row.value, COOKIE_LIMIT_BYTES, true);
  const cookiePath = normalizeCookiePath(row.path);
  if (!name || value === undefined || !cookiePath) return undefined;
  if (Buffer.byteLength(name) + Buffer.byteLength(value) > COOKIE_LIMIT_BYTES) return undefined;
  if (!isOptionalBoolean(row.secure) || !isOptionalBoolean(row.httpOnly)) return undefined;
  if (!isOptionalBoolean(row.hostOnly)) return undefined;

  const target = normalizeCookieTarget(row);
  if (!target) return undefined;
  const isHostOnly =
    row.hostOnly === true ||
    (row.hostOnly === undefined && typeof row.url === 'string' && row.domain === undefined);
  const expirationDate = normalizeExpiration(row.expirationDate ?? row.expires, nowMs);
  if (expirationDate === false) return undefined;
  const sameSite = normalizeSameSite(row.sameSite);
  if (row.sameSite !== undefined && sameSite === undefined) return undefined;
  if (sameSite === 'no_restriction' && !target.secure) return undefined;
  if (name.startsWith('__Secure-') && !target.secure) return undefined;
  if (
    name.startsWith('__Host-') &&
    (!target.secure || !isHostOnly || target.domain.startsWith('.') || cookiePath !== '/')
  ) {
    return undefined;
  }

  const cookie = {
    url: target.url,
    name,
    value,
    path: cookiePath,
    secure: target.secure,
    httpOnly: row.httpOnly === true,
  };
  if (!isHostOnly && target.domain) cookie.domain = target.domain;
  if (expirationDate !== undefined) cookie.expirationDate = expirationDate;
  if (sameSite) cookie.sameSite = sameSite;
  return cookie;
}

function normalizeCookieTarget(row) {
  const secure = row.secure === true;
  if (typeof row.url === 'string' && row.url.trim()) {
    const parsed = parseSafeHttpUrl(row.url);
    if (!parsed || !isValidHostname(parsed.hostname)) return undefined;
    return {
      url: `${secure ? 'https' : 'http'}://${parsed.host}/`,
      domain: parsed.hostname,
      secure,
    };
  }
  if (typeof row.domain !== 'string') return undefined;
  const domain = row.domain.trim().toLowerCase();
  const hostname = domain.startsWith('.') ? domain.slice(1) : domain;
  if (!isValidHostname(hostname)) return undefined;
  return {
    url: `${secure ? 'https' : 'http'}://${hostname}/`,
    domain,
    secure,
  };
}

function isValidHostname(hostname) {
  if (
    !hostname ||
    hostname.length > 253 ||
    hasControlCharacter(hostname) ||
    /[\s/@\\]/.test(hostname)
  ) {
    return false;
  }
  return parseSafeHttpUrl(`https://${hostname}/`)?.hostname === hostname;
}

function normalizeCookiePath(value) {
  const cookiePath = value === undefined || value === null ? '/' : value;
  if (
    typeof cookiePath !== 'string' ||
    !cookiePath ||
    !cookiePath.startsWith('/') ||
    cookiePath.length > 2_048 ||
    hasControlCharacter(cookiePath)
  ) {
    return undefined;
  }
  return cookiePath;
}

function normalizeCookieName(value) {
  const name = boundedCookieText(value, 256);
  if (!name || [...name].some((character) => '()<>@,;:\\"/[]?={} \t'.includes(character))) {
    return undefined;
  }
  return name;
}

function normalizeExpiration(value, nowMs) {
  if (value === undefined || value === null || value === '' || Number(value) === 0)
    return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= nowMs / 1_000) return false;
  return seconds;
}

function normalizeSameSite(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).toLowerCase().replace(/[_ -]/g, '');
  if (normalized === 'strict') return 'strict';
  if (normalized === 'lax') return 'lax';
  if (normalized === 'none' || normalized === 'norestriction') return 'no_restriction';
  if (normalized === 'unspecified') return 'unspecified';
  return undefined;
}

function boundedCookieText(value, maxLength, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maxLength || hasControlCharacter(value)) {
    return undefined;
  }
  if (!allowEmpty && !value) return undefined;
  return value;
}

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function cookieHostname(cookie) {
  return new URL(cookie.url).hostname;
}

function cookieKey(cookie) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.path !== 'string')
    return undefined;
  let hostname;
  if (typeof cookie.domain === 'string' && cookie.domain) {
    hostname = cookie.domain.replace(/^\./, '').toLowerCase();
  } else if (typeof cookie.url === 'string') {
    try {
      hostname = new URL(cookie.url).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (!hostname) return undefined;
  return `${hostname}\0${cookie.path}\0${cookie.name}`;
}

function hasUnsupportedPartition(row) {
  return (
    row.partitioned === true || row.partitionKey !== undefined || row.partition_key !== undefined
  );
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function assertCookieStore(cookieStore) {
  if (!cookieStore || typeof cookieStore.set !== 'function') {
    throw new Error('Browser cookie storage is unavailable.');
  }
}

module.exports = {
  BrowserCookieImportCommitError,
  COOKIE_EXPORT_LIMIT_BYTES,
  COOKIE_LIMIT_BYTES,
  PROFILE_COOKIE_IMPORT_COMMIT,
  commitCookieBatch,
  commitBrowserCookieImport,
  createBrowserCookieImportPlan,
  discardBrowserCookieImportPlan,
  isValidHostname,
};

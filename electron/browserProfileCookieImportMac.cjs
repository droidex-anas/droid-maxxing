const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CHROME_COOKIE_SCHEMA_VERSION = 24;
const CHROME_TO_UNIX_EPOCH_MICROSECONDS = 11_644_473_600_000_000n;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const CHROME_PROFILE_LIMIT = 50;
const COOKIE_LIMIT = 5_000;
const LOCAL_STATE_LIMIT_BYTES = 5 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

// Current Chromium macOS cookies use schema v24, a Keychain-backed PBKDF2 key,
// AES-128-CBC `v10` ciphertext, and a SHA-256 host binding inside plaintext.

async function discoverChromeProfiles(homeDir) {
  const root = chromeUserDataPath(homeDir);
  let localState;
  try {
    localState = JSON.parse(await readBoundedFile(path.join(root, 'Local State')));
  } catch {
    return [];
  }
  const infoCache = localState?.profile?.info_cache;
  if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) return [];
  const lastUsed = localState.profile.last_used;
  const profiles = [];
  for (const [profileId, info] of Object.entries(infoCache)) {
    if (profiles.length >= CHROME_PROFILE_LIMIT || !isChromeProfileId(profileId)) continue;
    const cookieDatabasePath = await findChromeCookieDatabasePath(root, profileId);
    if (!cookieDatabasePath) continue;
    profiles.push(
      Object.freeze({
        id: profileId,
        label: normalizeProfileLabel(info?.name, profileId),
        isLastUsed: profileId === lastUsed,
        cookieDatabasePath,
      }),
    );
  }
  profiles.sort((left, right) => {
    if (left.isLastUsed !== right.isLastUsed) return left.isLastUsed ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
  return profiles;
}

async function findChromeCookieDatabasePath(root, profileId) {
  for (const candidate of [
    path.join(root, profileId, 'Network', 'Cookies'),
    path.join(root, profileId, 'Cookies'),
  ]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Chrome has used both profile layouts; keep checking the known alternatives.
    }
  }
  return undefined;
}

async function readChromeProfileCookies({ profileId, homeDir, nowMs }, dependencies = {}) {
  assertChromeProfileId(profileId);
  const profile = (await discoverChromeProfiles(homeDir)).find(
    (candidate) => candidate.id === profileId,
  );
  if (!profile) {
    throw profileError(
      'CHROME_PROFILE_NOT_FOUND',
      'The selected Chrome profile is no longer available. Reopen Settings and try again.',
    );
  }

  const readResult = readChromeCookieRows(profile.cookieDatabasePath, dependencies.DatabaseSync);
  let key;
  try {
    if (readResult.hasEncryptedValues) {
      const keychainPassword = await readChromeKeychainPassword(dependencies.readKeychainPassword);
      try {
        key = crypto.pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1');
      } finally {
        keychainPassword.fill(0);
      }
    }
    const parsed = normalizeChromeRows(readResult.rows, key, nowMs);
    return {
      profile,
      cookies: parsed.cookies,
      skippedCount: parsed.skippedCount,
      keychainApproved: readResult.hasEncryptedValues,
    };
  } finally {
    key?.fill(0);
    clearChromeRows(readResult.rows);
  }
}

function readChromeCookieRows(databasePath, Database = DatabaseSync) {
  let database;
  try {
    database = new Database(databasePath, { readOnly: true, timeout: 5_000 });
    const versionRow = database.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    if (Number(versionRow?.value) !== CHROME_COOKIE_SCHEMA_VERSION) {
      throw profileError(
        'CHROME_COOKIE_SCHEMA_UNSUPPORTED',
        'This Chrome cookie store version is not supported yet. Update DROIDEX or use a cookie export.',
      );
    }
    assertCookieColumns(database);
    const rows = database
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path,
                CAST(expires_utc AS TEXT) AS expires_utc_text, has_expires,
                is_secure, is_httponly, samesite, top_frame_site_key
           FROM cookies
          ORDER BY last_update_utc ASC, creation_utc ASC
          LIMIT ${COOKIE_LIMIT + 1}`,
      )
      .all();
    if (rows.length > COOKIE_LIMIT) {
      clearChromeRows(rows);
      throw profileError(
        'CHROME_PROFILE_COOKIE_LIMIT_EXCEEDED',
        `The Chrome profile contains more than ${COOKIE_LIMIT} cookies. Remove stale Chrome site data or use a smaller export.`,
      );
    }
    return {
      rows,
      hasEncryptedValues: rows.some((row) => byteLength(row.encrypted_value) > 0),
    };
  } catch (error) {
    if (error?.code) throw error;
    throw profileError(
      'CHROME_COOKIE_DATABASE_UNAVAILABLE',
      'Chrome cookies could not be read. Quit Chrome and retry, or use a cookie export.',
    );
  } finally {
    try {
      database?.close();
    } catch {
      // The fixed read-only connection owns no writes; the public error above is sufficient.
    }
  }
}

function assertCookieColumns(database) {
  const available = new Set(
    database
      .prepare('PRAGMA table_info(cookies)')
      .all()
      .map((row) => row.name),
  );
  const required = [
    'host_key',
    'name',
    'value',
    'encrypted_value',
    'path',
    'expires_utc',
    'has_expires',
    'is_secure',
    'is_httponly',
    'samesite',
    'top_frame_site_key',
    'last_update_utc',
    'creation_utc',
  ];
  if (required.some((column) => !available.has(column))) {
    throw profileError(
      'CHROME_COOKIE_SCHEMA_UNSUPPORTED',
      'This Chrome cookie store version is not supported yet. Update DROIDEX or use a cookie export.',
    );
  }
}

async function readChromeKeychainPassword(injectedReader) {
  try {
    const password = injectedReader ? await injectedReader() : await executeSecurityCommand();
    const bytes = Buffer.isBuffer(password) ? password : Buffer.from(password || '');
    if (bytes.length === 0 || bytes.length > 4_096) {
      bytes.fill(0);
      throw new Error('invalid password');
    }
    return bytes;
  } catch {
    throw profileError(
      'CHROME_KEYCHAIN_ACCESS_DENIED',
      'Chrome cookie access was not approved in macOS Keychain. Approve access and retry.',
    );
  }
}

function executeSecurityCommand() {
  // This fixed system command may present macOS's Keychain consent UI. Callers
  // must obtain DROIDEX's native preflight approval before creating a plan.
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-a', 'Chrome', '-s', 'Chrome Safe Storage'],
      { encoding: 'buffer', maxBuffer: 8 * 1024, timeout: 120_000 },
      (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout)) {
          if (Buffer.isBuffer(stdout)) stdout.fill(0);
          reject(new Error('keychain access failed'));
          return;
        }
        let end = stdout.length;
        if (end > 0 && stdout[end - 1] === 0x0a) end -= 1;
        if (end > 0 && stdout[end - 1] === 0x0d) end -= 1;
        resolve(Buffer.from(stdout.subarray(0, end)));
        stdout.fill(0);
      },
    );
  });
}

function normalizeChromeRows(rows, key, nowMs) {
  const cookiesByKey = new Map();
  let skippedCount = 0;
  for (const row of rows) {
    const cookie = normalizeChromeRow(row, key, nowMs);
    if (!cookie) {
      skippedCount += 1;
      continue;
    }
    const cookieId = `${cookie.hostname}\0${cookie.details.path}\0${cookie.details.name}`;
    const previous = cookiesByKey.get(cookieId);
    if (previous) {
      previous.value.fill(0);
      skippedCount += 1;
    }
    cookiesByKey.set(cookieId, cookie);
  }
  return { cookies: [...cookiesByKey.values()], skippedCount };
}

function normalizeChromeRow(row, key, nowMs) {
  if (!row || typeof row !== 'object' || row.top_frame_site_key !== '') return undefined;
  const hostname = normalizeChromeHostname(row.host_key);
  const name = normalizeCookieName(row.name);
  const cookiePath = normalizeCookiePath(row.path);
  if (!hostname || !name || !cookiePath) return undefined;
  if (
    !isSqliteBoolean(row.has_expires) ||
    !isSqliteBoolean(row.is_secure) ||
    !isSqliteBoolean(row.is_httponly)
  ) {
    return undefined;
  }
  const secure = row.is_secure === 1;
  const sameSite = chromeSameSite(row.samesite);
  if (sameSite === false || (sameSite === 'no_restriction' && !secure)) return undefined;
  if (name.startsWith('__Secure-') && !secure) return undefined;
  if (
    name.startsWith('__Host-') &&
    (!secure || row.host_key.startsWith('.') || cookiePath !== '/')
  ) {
    return undefined;
  }
  let expirationDate;
  if (row.has_expires === 1) {
    expirationDate = chromeTimestampToUnixSeconds(row.expires_utc_text);
    if (expirationDate === undefined || expirationDate <= nowMs / 1_000) return undefined;
  }

  const value = decryptChromeCookieValue(row, key);
  if (!value || value.length > 4_096 || value.length + Buffer.byteLength(name) > 4_096) {
    value?.fill(0);
    return undefined;
  }
  try {
    // eslint-disable-next-line no-control-regex -- Cookie values containing control bytes are unsafe to import.
    if (/[\u0000-\u001f\u007f]/.test(UTF8_DECODER.decode(value))) {
      value.fill(0);
      return undefined;
    }
  } catch {
    value.fill(0);
    return undefined;
  }

  const details = {
    url: `${secure ? 'https' : 'http'}://${hostname}/`,
    name,
    path: cookiePath,
    secure,
    httpOnly: row.is_httponly === 1,
    sameSite,
  };
  if (row.host_key.startsWith('.')) details.domain = row.host_key.toLowerCase();
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  return { hostname, details: Object.freeze(details), value };
}

function chromeTimestampToUnixSeconds(rawTimestamp) {
  if (typeof rawTimestamp !== 'string' || !/^\d{1,20}$/.test(rawTimestamp)) return undefined;
  let unixMicroseconds;
  try {
    unixMicroseconds = BigInt(rawTimestamp) - CHROME_TO_UNIX_EPOCH_MICROSECONDS;
  } catch {
    return undefined;
  }
  if (unixMicroseconds <= 0n) return undefined;
  const wholeSeconds = unixMicroseconds / MICROSECONDS_PER_SECOND;
  if (wholeSeconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const remainingMicroseconds = unixMicroseconds % MICROSECONDS_PER_SECOND;
  const timestamp = Number(wholeSeconds) + Number(remainingMicroseconds) / 1_000_000;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function decryptChromeCookieValue(row, key) {
  const encrypted = Buffer.from(row.encrypted_value || []);
  if (encrypted.length === 0) {
    if (typeof row.value !== 'string') return undefined;
    return Buffer.from(row.value, 'utf8');
  }
  if (
    row.value !== '' ||
    !key ||
    encrypted.length <= 3 ||
    !encrypted.subarray(0, 3).equals(Buffer.from('v10'))
  ) {
    encrypted.fill(0);
    return undefined;
  }
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const expectedHash = crypto.createHash('sha256').update(row.host_key).digest();
    if (
      plaintext.length < expectedHash.length ||
      !crypto.timingSafeEqual(plaintext.subarray(0, expectedHash.length), expectedHash)
    ) {
      plaintext.fill(0);
      return undefined;
    }
    const value = Buffer.from(plaintext.subarray(expectedHash.length));
    plaintext.fill(0);
    return value;
  } catch {
    plaintext?.fill(0);
    return undefined;
  } finally {
    encrypted.fill(0);
  }
}

async function readBoundedFile(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LOCAL_STATE_LIMIT_BYTES) throw new Error('invalid file');
    const buffer = Buffer.allocUnsafe(LOCAL_STATE_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > LOCAL_STATE_LIMIT_BYTES) throw new Error('file changed');
    return UTF8_DECODER.decode(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}

function chromeUserDataPath(homeDir) {
  return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
}

function assertChromeProfileId(profileId) {
  if (!isChromeProfileId(profileId)) {
    throw profileError('CHROME_PROFILE_INVALID', 'Select a valid discovered Chrome profile.');
  }
}

function isChromeProfileId(profileId) {
  return profileId === 'Default' || /^Profile [1-9]\d{0,3}$/.test(profileId);
}

function normalizeProfileLabel(label, fallback) {
  if (
    typeof label !== 'string' ||
    !label.trim() ||
    label.length > 80 ||
    // eslint-disable-next-line no-control-regex -- Persisted profile labels must reject control bytes.
    /[\u0000-\u001f\u007f]/.test(label)
  ) {
    return fallback;
  }
  return label.trim();
}

function normalizeChromeHostname(hostKey) {
  if (typeof hostKey !== 'string') return undefined;
  const hostname = hostKey.replace(/^\./, '').toLowerCase();
  // eslint-disable-next-line no-control-regex -- Imported hostnames must reject control bytes.
  if (!hostname || hostname.length > 253 || /[\s\u0000-\u001f\u007f/@\\]/.test(hostname)) {
    return undefined;
  }
  try {
    return new URL(`https://${hostname}/`).hostname === hostname ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCookieName(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    // eslint-disable-next-line no-control-regex -- Cookie names must reject control bytes and separator characters.
    /[\u0000-\u001f\u007f()<>@,;:\\"/[\]?={} \t]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function normalizeCookiePath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.length > 2_048 ||
    // eslint-disable-next-line no-control-regex -- Cookie paths must reject control bytes.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function chromeSameSite(value) {
  if (value === -1 || value === 3) return 'unspecified';
  if (value === 0) return 'no_restriction';
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  return false;
}

function byteLength(value) {
  return value instanceof Uint8Array ? value.byteLength : 0;
}

function isSqliteBoolean(value) {
  return value === 0 || value === 1;
}

function clearChromeRows(rows) {
  for (const row of rows) {
    if (row?.encrypted_value instanceof Uint8Array) row.encrypted_value.fill(0);
  }
  rows.length = 0;
}

function clearNormalizedCookies(cookies) {
  for (const cookie of cookies) cookie.value.fill(0);
  cookies.length = 0;
}

function profileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  clearNormalizedCookies,
  discoverChromeProfiles,
  readChromeProfileCookies,
};

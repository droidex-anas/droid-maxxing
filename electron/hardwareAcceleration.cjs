const crypto = require('node:crypto');
const path = require('node:path');

const PREFERENCE_VERSION = 1;
const HARDWARE_ACCELERATION_DEFAULT = true;
const PREFERENCE_FILENAME = 'hardware-acceleration-preferences.json';

function preferenceFilePath(userDataDir) {
  return path.join(userDataDir, PREFERENCE_FILENAME);
}

function resolveUserDataDir({ app, env = process.env, appName = 'DROIDEX' }) {
  return env.DROIDEX_USER_DATA_DIR || path.join(app.getPath('appData'), appName);
}

function parseHardwareAccelerationPreference(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = JSON.parse(raw);
  if (parsed?.version === PREFERENCE_VERSION && typeof parsed.enabled === 'boolean') {
    return { enabled: parsed.enabled };
  }
  return null;
}

function readHardwareAccelerationPreferenceSync(options) {
  const fs = options.fs ?? require('node:fs');
  try {
    const preference = parseHardwareAccelerationPreference(
      fs.readFileSync(options.filePath, 'utf8'),
    );
    if (preference) return preference;
  } catch {
    // Missing, empty, or malformed preferences fall back to the default.
  }
  return { enabled: HARDWARE_ACCELERATION_DEFAULT };
}

async function loadHardwareAccelerationPreference(options) {
  try {
    const preference = parseHardwareAccelerationPreference(
      await options.fs.readFile(options.filePath, 'utf8'),
    );
    if (preference) return preference;
    throw new Error('Hardware acceleration preference is invalid. Toggle it again in Settings.');
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: HARDWARE_ACCELERATION_DEFAULT };
    throw error;
  }
}

async function saveHardwareAccelerationPreference(options) {
  if (typeof options.enabled !== 'boolean') {
    throw new Error('Hardware acceleration preference must be boolean.');
  }
  const temporaryPath = `${options.filePath}.${crypto.randomUUID()}.tmp`;
  await options.fs.mkdir(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
  try {
    await options.fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ version: PREFERENCE_VERSION, enabled: options.enabled }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await options.fs.rename(temporaryPath, options.filePath);
  } catch (error) {
    try {
      await options.fs.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
  return { enabled: options.enabled };
}

module.exports = {
  HARDWARE_ACCELERATION_DEFAULT,
  loadHardwareAccelerationPreference,
  parseHardwareAccelerationPreference,
  preferenceFilePath,
  readHardwareAccelerationPreferenceSync,
  resolveUserDataDir,
  saveHardwareAccelerationPreference,
};

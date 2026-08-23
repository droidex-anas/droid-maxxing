const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE_ENTITLEMENTS_PATH = 'assets/brand/entitlements.mac.plist';
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

function prepareMacEntitlements(options) {
  if (!options.isReleaseBuild) {
    return { entitlementsPath: BASE_ENTITLEMENTS_PATH, webAuthnKeychainAccessGroup: '' };
  }

  const teamId = options.teamId?.trim() ?? '';
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new Error(
      'DROIDEX release builds require APPLE_TEAM_ID to be a 10-character Apple Developer Team ID for Touch ID passkey entitlements.',
    );
  }

  const webAuthnKeychainAccessGroup = `${teamId}.app.droidex.webauthn`;
  const baseEntitlements = fs.readFileSync(
    path.join(options.projectRoot, BASE_ENTITLEMENTS_PATH),
    'utf8',
  );
  if (!baseEntitlements.includes('</dict>')) {
    throw new Error('DROIDEX macOS entitlements are malformed: missing the closing dictionary.');
  }

  const signedEntitlements = baseEntitlements.replace(
    '  </dict>',
    `    <key>keychain-access-groups</key>\n    <array>\n      <string>${webAuthnKeychainAccessGroup}</string>\n    </array>\n  </dict>`,
  );
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'droidex-entitlements-'));
  const entitlementsPath = path.join(outputDirectory, 'entitlements.mac.plist');
  fs.writeFileSync(entitlementsPath, signedEntitlements, { mode: 0o600 });

  return { entitlementsPath, webAuthnKeychainAccessGroup };
}

module.exports = { prepareMacEntitlements };

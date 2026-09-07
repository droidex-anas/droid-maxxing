# Runbooks

These runbooks cover local development and release triage for DROIDEX.

## User feedback report

1. Ask the user for the copyable `RPT-…` report ID shown after `/bug` or
   `/feedback` submission.
2. Search the private Sentry project by `report_id`. Use `installation_id` only
   when correlating multiple reports from the same pseudonymous installation.
3. Create only a sanitized source-repository issue when public tracking is useful.
   Keep the report ID, description, and attachments in private Sentry.
4. Keep report descriptions and crash attachments out of the public releases
   repository.

## Release Health and profile usage

1. Open the private Sentry Electron project and select Releases or Release
   Health.
2. Filter the environment to `production`. Development launches use the same
   project but a separate `development` environment.
3. Use sessions for app-launch volume, unique users for pseudonymous active local
   profiles, and crash-free sessions for reliability. These are not counts of
   named people, accounts, physical devices, or downloads.
4. Group by `release` to compare observed adoption. The first release observed
   for a `USR-…` profile is its first observed version; seeing the same profile
   later proves only that it was active on a later version. It does not prove
   whether Sparkle or a manual reinstall produced that transition.
5. Do not interpret Sentry as feature analytics. DROIDEX sends no product
   interaction events.
6. Restrict crash-event and minidump access to incident/release operators. Apply
   the approved Sentry retention policy and never copy crash material into the
   public releases repository.

## App does not start in Electron development mode

1. Confirm dependencies are installed:
   ```bash
   npm install
   npm ci --prefix sidecar
   ```
2. Confirm Vite is reachable at the URL used by Electron:
   ```bash
   npm run dev
   ```
3. In another terminal, launch Electron:
   ```bash
   npm run electron
   ```
4. If the renderer is blank, set `ELECTRON_START_URL=http://127.0.0.1:1420` in `.env`.
5. Run syntax and build checks:
   ```bash
   npm run electron:check
   npm run sidecar:build
   ```

## Sidecar bridge is unreachable

1. Check the Electron log for the dynamically assigned bridge port. The
   renderer must obtain its short-lived connection information through the
   authenticated preload bridge; there is no unauthenticated local mode.
2. Run sidecar tests and typecheck:
   ```bash
   npm --prefix sidecar run test
   npm run sidecar:typecheck
   ```
3. In development, rebuild the canonical sidecar entry with
   `npm run sidecar:build`. Packaged builds do not accept a sidecar path
   override.

## Publish a macOS release

1. Confirm the source version is final and the release branch checks are green.
2. Confirm the protected `macos-release` GitHub environment contains the public
   Sentry DSN and Sparkle private key documented in
   `docs/deployment-observability.md`.
3. Build both architectures with `DROIDEX_UNSIGNED_RELEASE_BUILD=1`, generate
   the two signed appcasts, and write `SHA256SUMS`.
4. Push the exact release branch, then run the executable unsigned
   release preflight and resolve every failure:
   ```bash
   npm run release:preflight:unsigned
   ```
5. Create the public GitHub release as a draft. Upload only two DMGs, two ZIPs,
   `appcast-arm64.xml`, `appcast-x64.xml`, and `SHA256SUMS`. Verify every remote
   asset byte-for-byte before publishing the immutable release.
6. On the public repository, confirm the published release contains exactly
   those seven assets and that the website download buttons target the DMGs.
7. Download each DMG from the public release on a clean Intel/Apple silicon Mac
   as applicable, install it, start a Droid session, submit a private `/bug`
   report, and record the result.
8. For subsequent releases, complete the Sparkle N-1-to-N update smoke before
   treating the release as operationally ready.

The ad-hoc-signed first-launch recovery is: open System Settings, choose Privacy &
Security, find the blocked DROIDEX notice, choose Open Anyway, and confirm. Do
not advise users to disable Gatekeeper globally.

## Local child-session index has an incompatible schema

The local index uses one canonical schema and has no migration or compatibility fallback. If startup reports an incompatible child-session index:

1. Quit DROIDEX.
2. Remove only the local derived index files:
   ```bash
   rm -f "$HOME/.factory/droidex/session-index.sqlite"
   rm -f "$HOME/.factory/droidex/session-index.sqlite-wal"
   rm -f "$HOME/.factory/droidex/session-index.sqlite-shm"
   ```
3. Restart DROIDEX. The sidecar rebuilds the index from current local Factory session history.

These commands do not remove raw Factory session history. Do not delete the broader `~/.factory` directory.
Do not remove `index.sqlite`; that filename remains reserved for older app/worktree schemas.

## Verify child navigation without Factory authentication

Run the deterministic local Electron smoke:

```bash
npm run test:smoke:electron-child-sessions
```

The smoke uses the real Electron main process, preload, and built renderer with a local fixture sidecar. It strips `FACTORY_API_KEY` and `DROID_PATH`, makes no Factory/Droid calls, and verifies parent-only left navigation, parent-scoped child rows, exact transcripts, stale-open isolation, steer, and Stop targeting.

## Droid CLI cannot be found

1. Run `droid --version` in the same shell that starts the app.
2. If PATH discovery is not reliable, set `DROID_PATH` in `.env` to the absolute CLI path.
3. Remove stale `DROID_PATH` values if the binary was moved.
4. Re-run sidecar environment tests:
   ```bash
   npm --prefix sidecar run test
   ```

## Factory API key problems

1. Prefer the app onboarding flow for key entry.
2. For local debugging, set `FACTORY_API_KEY` in `.env` or the shell.
3. Do not commit keys or paste them into logs.
4. If child processes still lack credentials, inspect sidecar startup logs and confirm the app is passing an explicit key.

## Build or CI failure

See also [browser authentication and permission checks](#browser-authentication-and-permission-checks)
before treating a desktop release as authentication-ready.

1. Reproduce the failing job locally with the same command listed in `.github/workflows/ci.yml`.
2. For broad changes, run:
   ```bash
   npm run docs:check
   npm run format:check
   npm run typecheck
   npm run sidecar:typecheck
   npm run electron:check
   npm run test
   npm --prefix sidecar run test
   npm run build
   ```
3. Check whether generated docs are stale. If so, run `npm run docs:generate` and commit the generated file.
4. Known baseline: lint is non-blocking in CI while the strict lint backlog is being paid down.

## Browser authentication and permission checks

These gates are independent; never solve a denial by disabling sandboxing,
web security, certificate validation, or OS consent.

| Capability | Required approval or release configuration | Recovery / limitation |
| --- | --- | --- |
| Chrome profile cookies | Explicit DROIDEX import approval, then macOS access to Chrome Safe Storage when encrypted cookies are present | Cancel or deny imports nothing. Unlock the login Keychain and retry when ready; never grant blanket Keychain access. No Full Disk Access is requested. Import does not copy passwords, local storage, or device-bound sessions. |
| Saved DROIDEX logins | OS-protected encryption available; save approval and per-use fill approval, plus Touch ID when available | If decryption fails, delete only the affected saved login in Browser settings and save it again. Do not reset the user's Keychain. |
| Touch ID WebAuthn | Developer ID-signed build, concrete Apple Team ID and matching `keychain-access-groups`, then the user's authenticator confirmation | The current release workflow is ad-hoc: Touch ID passkeys are intentionally unavailable. Configure the existing signed release build path before advertising them. |
| Website OAuth | Single-use authentication approval and an exact provider-popup target; provider allows embedded sign-in | Google prohibits embedded OAuth. Use a supported direct website login or an explicitly imported Chrome session. External-browser authentication does not automatically transfer session state into DROIDEX. |
| Camera / microphone | Browser settings set to Ask, exact-site approval, macOS TCC approval, usage descriptions, and hardened-runtime camera/audio-input entitlements | If OS access is denied, enable DROIDEX under System Settings > Privacy & Security > Camera or Microphone and restart. Site approval cannot override OS denial. |
| USB, HID, other unsupported website permissions | Not supported; denied by the browser permission controller | Do not add broad device, screen-recording, Accessibility, or Full Disk Access grants to work around unrelated authentication failures. |

### Signed-build acceptance

Automated tests verify policy and packaging inputs, not a real user's Keychain,
Touch ID hardware, provider account, or macOS privacy prompts. Before claiming
full authentication support, run these checks on the actual signed artifact:

1. Verify the app and helper signatures, Team ID, camera/audio-input entitlements,
   matching WebAuthn Keychain access group, and camera/microphone usage descriptions.
2. In a disposable test account, deny Chrome Keychain access and confirm nothing
   imports; retry with approval and confirm the receipt and reopened site session.
3. Save and fill a test login. Check cancel, Touch ID rejection, successful fill,
   app restart, and exact-origin isolation without logging credential values.
4. Test an allowed provider popup through redirect, opener completion, cancellation,
   and closure. Verify provider-rejected embedded OAuth is not advertised as working.
5. Register and use a test Touch ID passkey, including cancellation and account
   choice. This check must remain pending for an ad-hoc artifact.
6. Test camera and microphone with site denial, OS denial, approval, and revocation.
   Use a clean test macOS account when first-use prompts must be reproduced; do not
   reset the user's existing privacy permissions.

References: [Apple camera entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.camera),
[Apple audio-input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input),
[Electron WebAuthn configuration](https://www.electronjs.org/docs/latest/api/app#appconfigurewebauthnoptions-macos),
and [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

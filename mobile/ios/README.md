# DROIDEX for iOS 27

A native SwiftUI companion with two **explicitly separate** modes:

- **Connect a computer:** live Droid sessions through the desktop's existing SessionManager, actual model/effort catalog, streaming progress, permission approvals, questions, stop, and working-tree review.
- **Explore the offline preview:** the original scripted examples, clearly labelled. Connected mode never falls back to these examples.

The live path is a **local-network testing MVP**, not a public remote-access service. Both desktop and phone must use this PR's code. The installed release DMG will not have this feature until rebuilt.

## Try the connected build

### 1. Start this branch on your computer

From the repository root:

```sh
git fetch origin
git switch feat/droidex-ios27-mvp
git pull --ff-only
# Only when dependencies are not installed:
npm ci
npm --prefix sidecar ci
npm run electron:dev
```

Use the normal DROIDEX desktop login first. The phone reuses that computer's Droid account and quota; it does not ask for an API key.

**Prerequisites:** Git for working-tree diffs, and OpenSSL for a temporary local HTTPS certificate. macOS commonly provides `/usr/bin/openssl`; verify with `openssl version`. On Windows, make OpenSSL available on the process PATH, or set `DROIDEX_OPENSSL_PATH` to its executable before starting the desktop. No package is silently installed.

### 2. Enable mobile access in the desktop app

Choose **File → Connect phone…**. Select a workspace and the computer's private Wi-Fi/LAN IPv4 address. The `127.0.0.1` option is only for an iOS simulator on that same Mac; a physical iPhone must use the computer's LAN address.

Choose **Enable mobile access**, review the native permission warning, and copy the one-time pairing code. The workspace is a starting directory, **not an OS-level sandbox**. An approved agent command can access whatever the desktop account can access.

The code expires after three minutes. If it expires, is declined, or is cancelled, disable access and enable again to generate a fresh code. Keep it private.

### 3. Run the iOS app

```sh
open mobile/ios/Droidex.xcodeproj
```

Use Xcode 27 and an iOS 27 simulator or iPhone. Select the **Droidex** scheme. For a physical phone, configure your own signing team. Run with Command-R.

Choose **Add computer**, paste the code, and accept local-network access when iOS asks. Confirm **Approve phone** in the desktop pairing window. Then create a session, select a real model and its supported effort, and send a small prompt.

The first live harness is **Droid/Factory**, because that is the working runtime on this branch. Claude Code and Codex are not advertised as connected providers. Model names and supported effort levels come from the desktop catalog, not the preview enum.

## A useful first test

Use a throwaway Git repository with an initial commit. Start with a read-only prompt such as “List the top-level files and explain what this project contains.” Then request a small file edit. Review the actual permission request on the phone; **Approve once** forwards a single-use provider approval. It does not create a pretend success message.

Switch models on a follow-up and verify the actual desktop session settings. Start a longer turn, lock the phone, and reopen it. The computer continues working; foreground reconnection restores an authoritative snapshot and does **not** resubmit the prompt. **Stop** is a separate explicit action.

The diff viewer retains the existing design. It now shows Git working-tree changes, including staged, unstaged, and supported untracked text files. It may include edits that existed before this conversation. This is a read-only review, not an apply-ready patch and not a claim of per-turn attribution. Large/binary/unsupported files are reported as omitted. Files are capped at 30, lines at 4,000, and Git output at 256 KiB.

## Connection and security boundaries

The normal desktop WebSocket bridge remains loopback-only. A separate, narrow HTTPS endpoint starts **only after explicit desktop consent**. It supports pairing, catalog/bootstrap, session streaming, create/follow-up, stop, approvals, questions, and close. It does not forward arbitrary bridge commands, change the workspace from the phone, install software, expose unrelated sessions, or grant blanket approval.

A 256-bit single-use ticket is exchanged only after desktop confirmation. The phone pins the exact SHA-256 certificate fingerprint in the pairing code; redirects and other hosts are rejected. Requests then use a separate random bearer credential. Provider credentials stay on the computer. The phone's credential is stored in Keychain with device-only, unlocked-device access, not UserDefaults or the conversation archive.

The desktop's localhost-only control capability is stored with mode 0600 in its profile. Pairing material is not logged. The local certificate/key are temporary; restart or disabling access revokes the connection and requires re-pairing. **Do not port-forward this service or expose it to the public internet.** Use only a trusted private network. One phone/computer connection is supported in this MVP.

Closing the pairing window does not disable access. **Disable and revoke access** closes the listener, revokes the phone token and requests closure of remote-owned sessions. If a provider cannot be closed, the desktop reports the failure; inspect it locally. It does not undo edits. **Forget computer** on the phone only deletes its credential; revoke access on the desktop as well.

## Known MVP limits

- No internet relay, QR camera scanning, account-based device discovery, push notifications, background iOS streaming, or multi-computer switcher.
- Only sessions created through this connection sync to the phone, not the complete historical desktop inbox. Desktop restart requires pairing again. Unsent live drafts remain in phone memory, not a durable remote archive.
- Six sessions per connection, up to 50 turns per session and a bounded transcript budget. Start a fresh session or connection when the app reports a limit.
- Primary-agent activity is shown. Full child-agent panes, rich tool output, attachments, desktop browser control, and remote rename are outside this pass.
- Build/Plan and provider-supported effort are forwarded to the real session. Runtime permissions remain enabled with autonomy `off`. This is not unrestricted remote shell access, but approved agent actions are real and can incur provider costs.
- A network failure during Send is treated as uncertain delivery: reconnect before retrying. The app never automatically repeats a potentially accepted prompt.

## Validation and honest build status

Implemented and checked in this environment:

- **21 Swift core tests passed**, including the original archive/session tests and new connected-store tests for catalog selection, streaming projection, approval/question forwarding, stale revisions, uncertain delivery, and background/reconnect behavior.
- **13 desktop-side tests passed**, including real loopback HTTPS pairing and NDJSON streaming/reconnection. These tests use a **simulated provider runtime**, not an authenticated Factory account.
- Swift app syntax parsing and desktop JavaScript syntax checks passed. Project/plist files were inspected.

The container has **no Xcode, Apple SDK, iOS simulator, or logged-in desktop provider**. The native app has not been compiled/launched here, TLS/Keychain/local-network behavior has not been exercised on iOS, and a live paid-model request has not been run. SwiftUI syntax parsing is not typechecking. Keep the PR draft until the manual checks below pass on your Mac and phone.

Run on a fully installed checkout:

```sh
npm run sidecar:typecheck
npm --prefix sidecar run test
node --check electron/mobile/desktop.cjs
node --check electron/mobile/preload.cjs
node --check electron/mobile/window.js
swift test --package-path mobile/ios/DroidexCore
```

The Linux Swift toolchain used here required `-Xlinker --allow-shlib-undefined` for its Observation runtime; that workaround is **not** added to the app's build settings. Node tests were transpiled with the available TypeScript compiler and run with `node --test`, because the complete repository dependency installation was unavailable here. This is not a claim that the entire desktop repository build passed.

Before promoting this PR, check: iPhone/iPad compilation, local-network permission denied/allowed, certificate-pin mismatch, expired/declined pairing, live login failure, actual model switching and billing, approval/decline, question answers, Stop during startup, foreground reconnect without duplicate work, and revocation while a turn is running. Also verify Dynamic Type, landscape, keyboard avoidance, VoiceOver and haptics on a physical iPhone.

## Code map

- `sidecar/src/remote`: opt-in server, pairing/authentication, owned-session projection and read-only Git diff extraction.
- `electron/mobile`: isolated desktop pairing window, explicit native consent/folder selection and narrow preload.
- `DroidexCore/RemoteProtocol.swift`: versioned wire DTOs, validated pairing-code parser and desktop-service boundary.
- `DroidexCore/SessionStore.swift`: one UI state owner, with distinct preview and connected paths.
- `DroidexApp/Remote`: pinned URLSession transport, Keychain storage and onboarding.
- `DroidexApp/Features/ConfigurationControls.swift`: shared live model/effort selectors used before and during a session. Text-first controls, no decorative model/harness/effort icons.

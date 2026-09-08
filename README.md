# DROIDEX

DROIDEX is a macOS desktop workspace for Factory Droid. It keeps chats,
projects, terminals, browser sessions, and agent work together in one app.

Website: [droidex.vercel.app](https://droidex.vercel.app)

## License and contributions

DROIDEX is proprietary source-available software, not open-source software.
You may inspect the code and create a fork solely to propose contributions to
this repository. Reuse, redistribution, deployment as another project, and
claims of ownership are prohibited without written permission. See
[LICENSE](LICENSE) for the complete terms. Contributions are welcome under the
process in [CONTRIBUTING.md](CONTRIBUTING.md) and the copyright-assignment terms
in [CLA.md](CLA.md).

## Run it locally

You need Node.js 22, npm, and the Factory Droid CLI. DROIDEX can install the
CLI during onboarding if it is not already available.

Install dependencies and launch the desktop app:

```bash
npm install
npm ci --prefix sidecar
npm run electron
```

For renderer-only development, use:

```bash
npm run dev
```

## GitHub pull requests

For GitHub repositories, the Context panel shows pull requests, checks, and
review comments through GitHub CLI. If `gh` is missing or signed out, DROIDEX
shows the recovery action in Context. It can install `gh` through an existing
Homebrew installation; otherwise it opens GitHub's official installation page.
Authentication always completes through GitHub CLI's browser/device flow. The
Context popover keeps the one-time code visible and copyable until `gh` confirms
the account is connected.

## DROIDEX Browser

DROIDEX includes a native browser an agent can drive while the user keeps
control of sign-ins and sensitive capabilities. Each task keeps its own browser
session and background work stays live, while the authenticated profile is
shared across chats so sites do not ask for a fresh sign-in per chat. An
optional agent cursor shows where the agent hovers and clicks.

Opening a site follows the chat's autonomy by default: High opens any safe
HTTP(S) site, Medium asks for each new origin, and Low or Off asks every time.
Full site access is a separate setting and still refuses local files, embedded
credentials, executable URLs, and browser-internal pages.

**Settings → Browser** owns agent access, the site policy, the home and search
page, the agent cursor, saved logins, downloads, camera and microphone
requests, diagnostics, and clearing browser data.

Sign-in stays user-approved: filling a saved login and submitting an
authentication form each require their own native approval. On macOS, Settings
can import current cookies from a local Chrome profile after a DROIDEX
confirmation and a Chrome Safe Storage Keychain approval; it copies no
passwords and cannot transfer every session. Safari has no supported import, so
sign in to those accounts directly in DROIDEX. Google prohibits OAuth in
embedded browsers, and Touch ID passkeys are unavailable in ad-hoc builds.

Boundaries and module ownership live in
[docs/architecture.md](docs/architecture.md#native-browser-boundary). Approval
recovery and release checks live in
[docs/runbooks.md](docs/runbooks.md#browser-authentication-and-permission-checks).

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the frontend dev server |
| `npm run electron` | Build the browser preload bundle and the sidecar, then launch DROIDEX |
| `npm run build` | Create a production build |
| `npm run test` | Run app and Electron tests |
| `npm --prefix sidecar run test` | Run sidecar unit tests |
| `npm run typecheck` | Check app TypeScript |
| `npm run sidecar:typecheck` | Check sidecar TypeScript |
| `npm run format:check` | Check formatting |

## Updates

DROIDEX checks its signed Sparkle feed for new versions. A blue download button
appears beside Settings only when a newer version is available. Clicking it
opens Sparkle's native update window; nothing downloads or installs until the
user approves it. You can also check manually from the DROIDEX menu.

Official macOS downloads and first-launch instructions live in the
[public releases repository](https://github.com/droidex-anas/droidex-releases).
The permanent website links and tag-controlled publishing flow are documented
in `docs/releasing.md`.

## Privacy and diagnostics

Automatic crash reports and Sentry Release Health are enabled by default in
release builds. They use a random local profile ID and can include crash stacks,
native crash dumps, and technical device/runtime context. Crash material can
contain incidental sensitive data; access belongs only to the private DROIDEX
Sentry project. DROIDEX does not intentionally attach account identity or use
Sentry for feature analytics.

Users can turn automatic diagnostics off under **Settings → Privacy &
diagnostics**. Changing the preference restarts DROIDEX. Disabling it stops
automatic reporting and deletes the local profile ID. `/bug` and `/feedback`
reports are sent only when the user explicitly submits them; while automatic
diagnostics are off, those reports use a non-persisted report-scoped ID.

## More documentation

- Architecture overview: `docs/architecture.md`
- Command reference: `docs/generated/project-reference.md`
- Runbooks: `docs/runbooks.md`
- Team release guide: `docs/releasing.md`
- Release controls and observability: `docs/deployment-observability.md`
- Engineering instructions: `AGENTS.md`

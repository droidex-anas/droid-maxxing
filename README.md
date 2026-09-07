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

The built-in DROIDEX Browser gives an agent a reliable native browser session
with the user in control of sign-ins and sensitive capabilities. Every task
keeps its own browser session—even while the user views another chat—while
the authenticated browser profile is shared so sites do not require a fresh
sign-in per chat. The active pane can show a crisp curved DROIDEX agent cursor
with a soft blue activity halo and native eased movement at the agent's exact
hover and click position; its high-contrast style and
24–64 px size are configurable in Browser settings, and the
indicator is optional, is hidden when its document changes, and
never pulls a background task into the visible pane.

Active browser work stays live in the background. Idle hidden pages may be
suspended to keep memory bounded; returning to one restores its URL, viewport,
and scroll position. Unsaved page-local state is not preserved by suspension.

**Settings → Browser** controls global agent access, autonomy-aware website
opening, the Google-default home/search page, the agent cursor, saved-login use,
downloads, camera and microphone requests, and bounded diagnostic tools. With
the default “Follow autonomy” policy, High can open any safe HTTP(S) site,
Medium asks for each new exact origin, and Low or Off asks every time. Full site
access is also an explicit setting and still cannot open local files, embedded
credentials, executable URLs, or browser-internal pages.
First-party browser hover, click, and scroll tools defer to this policy instead
of interrupting the task with a second generic MCP approval; authentication,
downloads, and new-site boundaries still ask when the selected policy requires
it.

Mixed tool batches still require SDK approval for their non-browser actions.
If a browser setting or data-clearing action fails, DROIDEX reloads the current
host state: the operation may have partially completed. Review the refreshed
settings before retrying; if the host is unavailable, use Retry to reload them.

The browser address bar accepts either a website or an ordinary search. Text
that is not a valid website address is sent to Google, while unsafe schemes are
rejected. Address-bar navigation and reload are treated as direct user actions,
not mislabeled as agent requests.

DROIDEX uses one personal browser profile across its chats. On macOS, Settings
discovers local Chrome profiles and can import their current cookies after an
explicit DROIDEX confirmation and Chrome Safe Storage Keychain approval. The
settings page receives only an opaque plan ID plus domain/count/replacement
metadata; decrypted values live briefly in Electron main memory and are
zeroed after commit or cancellation. Settings retain a secret-free last-import
receipt with only the time, Chrome method/profile label, and aggregate counts.
Import closes current DROIDEX browser pages before updating the shared cookie
store, flushes completed writes, and asks the user to reopen the site so it can
rebuild a coherent session. Cookie import is best-effort: it does not copy
Chrome local storage, device-bound state, or partitioned cookies that Electron
cannot represent safely. A bounded JSON/Netscape file remains available only
as Chrome recovery. Safari does not provide a supported API for
copying live sessions, so Safari accounts are signed in directly inside
DROIDEX instead of opening a misleading file picker or asking for Full Disk
Access. Neither Chrome path imports browser passwords.

Logins saved directly in DROIDEX are encrypted with operating-system protected
storage (macOS Keychain on macOS), remain scoped to an exact HTTPS origin, and
require native approval each time by default. When macOS makes it available,
DROIDEX asks for Touch ID immediately before decrypting and filling the saved
login. Cookie and password values are injected only inside the native browser
process—they are never returned to the agent or settings renderer.

Agents can prepare signup, sign-in, OAuth, and supported WebAuthn/passkey flows.
Submitting an authentication action requires a single-use native approval;
cross-origin iframe authentication is never agent-operable. An approved OAuth
action may open one short-lived sandboxed provider window only for the exact
provider destination inspected before approval. The window shares the DROIDEX
profile and preserves the provider's opener flow, but is not exposed to agent
controls. Touch ID passkeys are enabled only in a Developer ID-signed macOS
release carrying its concrete Team-scoped keychain entitlement. Development
and ad-hoc builds report passkeys as unavailable instead of presenting a fake
capability. Provider consent, platform passkey prompts, account choice,
one-time codes, and saved-password fills remain user controlled.

Remote browser pages are sandboxed. Cross-origin popups, redirects, history
changes, and delayed page navigation all pass through the same main-process
policy; renderer prompts are not treated as the security boundary. Permission
questions appear as rounded DROIDEX sheets with Cancel focused by default.
Camera and microphone access is blocked by default; Ask mode offers allow once,
always allow this exact site, block once, and always block this exact site.
Remembered choices can be removed in Browser settings. macOS may still show its
mandatory first-use privacy sheet. USB and HID devices remain blocked, and
agent diagnostics are off by default. Diagnostics expose bounded inspect,
network, and console views—not raw Chrome DevTools Protocol access. Browser data
can be cleared from the same settings page at any time.

The current live page is authoritative even when the user navigates manually.
Agent `snapshot` observes that page without reopening a URL remembered from the
conversation. Reload recovers the last valid HTTP(S) page—or the configured
home page—if Chromium temporarily reports a blank/error document. The agent
cursor is a separate sandboxed click-through overlay above the website, so page
scripts cannot hide or remove it. Pages can imitate its artwork, so it is an
activity indicator, not proof that a page or authentication request is trusted.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the frontend dev server |
| `npm run electron` | Build the sidecar and launch DROIDEX |
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

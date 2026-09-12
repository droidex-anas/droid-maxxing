# Handoff — 2026-09-12 13:10 IST (polish integration)

Branch `polish/integration` (worktree `.claude/worktrees/design-platform-ux-v1-07dcae`), umbrella PR #222 → main. Merged stacked PRs: #223 prose file links + focus ring, #224 light theme token ramps, #225 collapse jump, #226 composer/onboarding sizes, #227 type scale, #228 overlays (native browser view hides under viewers; viewer toolbar above the image), #229 diff row tones across scroll, #230 virtualizer keeps row heights on width change, #231 tool-source marks from MCP host metadata. Plus direct commits: readable tool rows with the shared terminal panel, copy below the reply, model rows restored (clickable dots/arrows, no focus ring), utility pane hidden on full-content routes, composer centred under the context panel, timeline rail follows the column, light-mode contrast fixes, swatch hairline.

Workflow rules (memory): every stacked branch gets a PR against polish/integration; CodeRabbit needs `@coderabbitai review` (auto reviews off for non-default base); Cubic reviews automatically; Cursor Bugbot is out of quota. Never idle while waiting — keep 1-2 Opus agents busy. Keep the user's designed elements; polish = placement, size, states, bugs.

Open decisions for the user: Cmd+B is taken by composer bold (sidebar toggle advertises it); micro labels ≤10px need a scale step or stay; black scrims over images in light mode; "clear paddings" complaint not yet pointed at.

Running: read-only audit of sidebar, panels, settings, PR/automations workspaces (next queue). Second instance for the user: `ELECTRON_START_URL=http://127.0.0.1:1499 DROIDEX_USER_DATA_DIR="$HOME/Library/Application Support/DROIDEX-polish" npm run electron:dev` (profile seeded from DROIDEX-dev); the user stopped it at 12:02.

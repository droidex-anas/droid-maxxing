# Handoff — 2026-09-12 (transcript design polish)

Branch `claude/design-typography-polish-c60f3f` in worktree `.claude/worktrees/design-platform-ux-v1-07dcae`, based on origin/main 8c775b32, HEAD aa9c6772 (1 commit, 12 files). Renderer 1586 pass, electron 339 pass, typecheck clean; lint issues on touched files are all pre-existing (complexity, nested ternary, export-components).

Spec: docs/superpowers/specs/2026-09-12-transcript-polish-design.md.

Shipped: message actions float over the message (reply bottom-right, prompt bubble left) so rows never change height at settle; streaming caret is CSS at the end of the last line (`md-typing` + `.md-shell`); Working hides while the tail streams and takes over on idle, in a fixed 20px line box with a fade; prompt rows `pt-2`; composer width `calc(42rem+52px)` so its text edge aligns with the transcript column; error tag inline; 12.5/11.5/11px sizes normalised to 13/12; prompt-enter is a 10px rise over 320ms.

Not reproduced: the user's screenshot (prompt drawn beside the previous reply, Working under a copy icon during a 90s wait) did not reproduce in the isolated app with the replay sidecar, in prod build or Vite dev/StrictMode. The structural fix removes settle-time height changes, which was the only mechanism found.

Isolated test rig (session scratchpad): `seed.mjs` (rich transcript), `audit.mjs` (settled/hover/fold screenshots), `repro.mjs` (two-prompt streaming via `sidecar/dist/replay-slow.mjs`, a bundle of `replay-entry.ts` accepting `GUI_BENCH_REPLAY_OVERRIDES` JSON and `GUI_BENCH_REPLAY_TURN_DELAY_MS`). Electron binary in the worktree is a symlink to the main checkout's `node_modules/electron/dist/Electron.app`; `npm run sidecar:build` is required for the history worker.

Next: user review of the branch; then PR or merge.

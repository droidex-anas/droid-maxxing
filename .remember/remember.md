# Handoff — 2026-09-12 (polish integration branch)

Worktree `.claude/worktrees/design-platform-ux-v1-07dcae`, branch `polish/integration` (integration branch for the UI polish; stacked branches merge into it). HEAD b86f3ce4 (app-icons merged). Commits: aa9c6772 transcript polish, ac392d5e readable tool rows + file chips open in Review + banner offset, 91c197c9 row/chrome cleanup, merge of `polish/model-selector` (b43f1e02, agent-built, name-first model rows).

Agents: `polish/app-icons` (Opus, real app icons via app.getFileIcon) may still be running or have an uncommitted worktree at `.claude/worktrees/app-icons`; review and merge it. Audit findings (52 items) live in this session's transcript; queued follow-ups are listed at the end of docs/superpowers/specs/2026-09-12-transcript-polish-design.md.

User constraints: 5-hour usage window was at 8% at 02:36 IST, resetting ~03:15; run at most 1-2 Opus agents while the user is active, more after the reset. No blinking dots, no monospace in tool rows, no pills/tracked caps, delete dead code, responsive not hardcoded, papercuts not overhauls.

Test rig: scratchpad `seed.mjs`, `audit.mjs`, `repro.mjs`, `boot.mjs`; replay sidecar `sidecar/dist/replay-slow.mjs`. macOS crash-resume dialog blocked Electron launches after hard kills; fixed with `defaults write com.github.Electron ApplePersistenceIgnoreState -bool true`. Always close instances with app.close(), never kill -9.

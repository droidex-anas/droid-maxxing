# Multi-Provider Runtime v1 Implementation Plan

> **Scope note (2026-08-28):** The v1 provider union is now five: `droid`,
> `codex`, `claude`, `cursor`, and `grok`. Any statement of "three providers"
> or "the three exact v1 pairs" across this plan set should be read as five.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox syntax for tracking.

**Goal:** Ship one DROIDEX desktop runtime in which Droid remains the default
and Droid, Codex, and Claude sessions can run simultaneously through the same
provider-neutral UI.

**Architecture:** Preserve DROIDEX's SessionLifecycle, SessionRegistry,
SessionEventFlow, and SessionTimeline as the application owners. Add a compact
static ProviderRegistry and provider-owned Adapter/Session implementations,
with a fresh canonical SQLite store and provider-scoped renderer settings.

**Tech Stack:** TypeScript, React, Electron, Node.js 22.23.1, node:sqlite,
WebSocket bridge, Factory Droid SDK, Codex app-server JSONL protocol, Claude
Agent SDK.

## Global Constraints

- Work only in the local integration/multi-provider-v1 worktree and local
  child worktrees. Never push, open a PR, or create a remote branch.
- Base implementation on the reviewed architecture checkpoint
  8cd5cb09c26718c323541d47277524423788e236.
- Refresh T3 once before derived code begins and freeze the reviewed provider
  source SHA. The currently reviewed head is
  849bac8946c40420174b4187e36fcf17b5ea7cc4.
- Freeze the official Codex generated-protocol reference at
  678157acaa819d5510adfe359abb5d0392cfe461 and Claude Agent SDK at exact
  0.3.170 unless the required pre-coding refresh changes either input and the
  design is reviewed again.
- Preserve T3's MIT notice for copied or substantially derived code and the
  applicable Apache-2.0 notice for generated Codex protocol material.
- Prefix shell commands with `rtk`. Use Node.js 22.23.1 through
  `rtk mise exec node@22 -- <command>`.
- Droid is the default provider.
- Provider binding is immutable after session creation.
- `SessionSummary.configuration` is the sole parent-session owner of provider
  selection, model/options, mode, and autonomy.
- appSessionId and turnId are DROIDEX-generated before provider awaits.
- Canonical `turn.settled` events are the sole turn-terminal authority.
- Shutdown uses one absolute deadline, closes children before parents and
  SQLite last, and never grants per-provider timeout windows.
- Do not migrate, read, delete, or overwrite old DROIDEX or Factory history.
- Keep one canonical current-state code path. No aliases, migrations, legacy
  readers, silent fallback, or resume-as-new behavior.
- Preserve bounded transcript paging. Defer new loading and virtualization
  behavior.
- Do not add Effect, T3 RPC/server packages, T3 event sourcing, or a second
  orchestration/session-directory/event-bus layer.
- Do not store provider credentials, OAuth tokens, API keys, or raw account
  payloads in SQLite or renderer state.
- Every new production file stays below 500 lines.
- Do not materially grow SessionManager.ts, history.ts, SessionLifecycle.ts,
  ChildSessions.ts, protocol.ts, useStore.tsx, PromptInput.tsx, or
  SettingsPanel.tsx.
- Every task starts with a failing production-entry-point test, ends green, and
  lands as one small local commit.

## Cursor Cloud execution

This copy of the plan set was checked out from
`origin/integration/multi-provider-v1` at `ede366ce` onto current `origin/main`.

- Work on the Cloud Agent branch. Pushing and opening a PR is allowed here.
- Use the image Node.js 22. Do not prefix commands with `rtk` or
  `mise exec node@22 --`.
- Create sibling worktrees under `/workspace` when the adapter plan forks,
  not under `/Users/anas/Documents/droid-control`.
- Freeze T3/Codex/Claude provenance only when that source is available in the
  environment. Do not stall Foundation or Droid-core work on a missing T3 clone.

---

## Plan Set and Execution Order

Execute these plans in order:

1. docs/superpowers/plans/2026-08-12-multi-provider-foundation.md
2. docs/superpowers/plans/2026-08-12-provider-core-droid.md
3. docs/superpowers/plans/2026-08-12-codex-claude-adapters.md
4. docs/superpowers/plans/2026-08-12-provider-settings-convergence.md

The first two plans run serially on integration/multi-provider-v1.

After the Provider Core and Droid plan is green, execute the adapter plan's
shared Task P0 on the integration branch: perform the single upstream refresh,
freeze exact native-version evidence, complete the Claude legal/package
feasibility go/no-go, and land provenance/notices before derived code. Record
that provenance checkpoint commit.
From `/Users/anas/Documents/droid-control` (the repository root, not the active
worktree), create two sibling local worktrees:

~~~bash
rtk git worktree add /Users/anas/Documents/droid-control/.worktrees/multi-provider-codex -b integration/multi-provider-codex <provenance-checkpoint>
rtk git worktree add /Users/anas/Documents/droid-control/.worktrees/multi-provider-claude -b integration/multi-provider-claude <provenance-checkpoint>
~~~

Codex owns sidecar/src/providers/codex and its tests. Claude owns
sidecar/src/providers/claude, its tests, and the exact Claude SDK dependency.
Neither branch edits shared contracts, SessionLifecycle, SessionManager,
protocol mirrors, renderer files, or provider registration. Shared changes land
on the integration branch first and are merged into both adapter branches.

Merge adapter commits back without squashing. The integration branch alone
registers the adapters and completes Settings, renderer, bridge, simultaneous
session, packaging, documentation, and release gates.

## Program Checkpoints

- [ ] **Checkpoint A:** Fresh canonical storage serves Droid list, search,
  restore, and paging while old files remain untouched.
- [ ] **Checkpoint B:** Droid runs through ProviderAdapter/ProviderSession with
  all current behavior green, validated bridge inputs, shared-deadline shutdown,
  and no Factory types defining the common seam.
- [ ] **Checkpoint P:** Latest T3/provider refs, exact supported-version
  decisions, licenses/notices, Claude legal/package feasibility, and source maps
  are frozen before adapter branches fork.
- [ ] **Checkpoint C:** Codex backend vertical slice passes deterministic
  provider-local tests and fake-executable smoke on its local branch.
- [ ] **Checkpoint D:** Claude backend vertical slice passes deterministic
  provider-local tests, fake-executable smoke, and the packaging-feasibility
  spike on its local branch.
- [ ] **Checkpoint E:** Settings and renderer expose all three providers with
  truthful capability gating.
- [ ] **Checkpoint F:** Simultaneous Droid/Codex/Claude, crash isolation,
  restart, interaction settlement, shutdown, attribution, docs, and broad
  validation pass.

## Final Local Validation

Run from integration/multi-provider-v1 with Node 22:

~~~bash
rtk mise exec node@22 -- npm run format:check
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run electron:check
rtk mise exec node@22 -- npm run test
rtk mise exec node@22 -- npm --prefix sidecar run test
rtk mise exec node@22 -- npm run docs:check
rtk mise exec node@22 -- npm run quality:file-size
rtk mise exec node@22 -- npm run quality:deadcode
rtk mise exec node@22 -- npm run quality:boundaries
rtk mise exec node@22 -- npm run quality:provenance
rtk mise exec node@22 -- npm run quality:licenses
rtk mise exec node@22 -- npm run build
rtk mise exec node@22 -- npm run test:smoke:electron-providers
rtk mise exec node@22 -- npm run test:smoke:packaged-providers:mac
~~~

Authenticated and signed packaged smokes are explicit manual release gates.
Record their exact CLI/SDK versions and results locally. Do not publish
artifacts or push commits.

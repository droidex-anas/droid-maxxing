# Provider Registration, Settings, and Product Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the reviewed Droid, Codex, and Claude runtimes into one
provider-neutral product with canonical configuration, complete interactions,
visible failed-start recovery, deterministic and packaged smoke coverage, and
truthful release gates.

**Architecture:** The static `ProviderRegistry` keeps Droid first and retains
unavailable Codex/Claude placeholders until each real adapter clears its
evidence gates. The renderer has one provider feature owner for snapshots,
defaults, drafts, create locking, and capability decisions; parent sessions
carry only the canonical nested `SessionConfiguration`. Existing sidecar
lifecycle, interaction, persistence, and timeline owners remain authoritative.

**Tech Stack:** TypeScript, React 19, Node.js 22, Electron 39, Factory Droid
SDK, Codex app-server JSON-RPC, Claude Agent SDK, SQLite, Node test runner,
Playwright, and electron-builder.

## Global Constraints

- Begin only after the foundation and Provider Core/Droid plans are green and
  reviewed. Merge reviewed Codex and Claude commits locally without squashing;
  never push or create a PR.
- Follow
  `docs/superpowers/specs/2026-08-12-multi-provider-runtime-design.md`.
- Run every shell command through `rtk`; run Node through
  `rtk mise exec node@22 -- ...`.
- Every commit below must pass its listed focused tests, root typecheck,
  sidecar typecheck when sidecar code changed, Electron syntax checks when
  Electron code changed, and `quality:file-size`. Never knowingly commit an
  intermediate bridge or renderer shape that does not build.
- Droid is the first/default provider. A bound `providerInstanceId` is
  immutable. There is no fallback provider, resume-as-create path, legacy
  configuration reader, migration shim, dual command, or silent default.
- The renderer never stores or receives provider session IDs, credentials,
  homes, raw account/auth payloads, arbitrary recovery URLs/commands, native
  callbacks, or raw native errors.
- Provider defaults seed new drafts only. Explicit live-session settings apply
  to the next accepted turn; an in-flight turn keeps its captured configuration.
- Preserve the existing paging, loading, virtualization, coalescing, and
  released-tail algorithms and constants. Provider snapshots never enter
  transcript reducers.
- Keep new provider renderer ownership under `src/features/providers`. Do not
  materially grow `src/hooks/useStore.tsx`, `src/components/PromptInput.tsx`,
  `src/components/SettingsPanel.tsx`, or other oversized files. New production
  files remain below 500 lines.
- Signed/authenticated provider smokes remain release and marketed-ready
  blockers. They are never replaced by deterministic fakes or reported passing
  when signing/login evidence is unavailable.

---

### Task 1: Verify convergence gates and merge adapters without registering them

**Files:**

- Verify: `docs/provider-provenance.md`
- Verify: `docs/provider-native-version-matrix.md`
- Verify: `THIRD_PARTY_NOTICES.md`
- Verify: `third_party/t3-code/LICENSE`
- Verify: `third_party/codex-app-server/LICENSE` (complete Apache-2.0 text landed
  by P0 before either adapter branch)
- Verify: `third_party/codex-app-server/NOTICE`
- Verify: `third_party/claude-agent-sdk/LICENSE.md`
- Verify: `sidecar/src/providers/compatibility/fixtures/codex-supported.json`
- Verify: `sidecar/src/providers/compatibility/fixtures/codex-rejected.json`
- Verify: `sidecar/src/providers/compatibility/fixtures/claude-supported.json`
- Verify: `sidecar/src/providers/compatibility/fixtures/claude-rejected.json`
- Merge: reviewed commits from `integration/multi-provider-codex`
- Merge: reviewed commits from `integration/multi-provider-claude`
- Do not modify: `sidecar/src/providers/ProviderRegistry.ts`

**Gate:** P0 must contain the frozen T3 SHA, official Codex ref, complete
licenses/notices, and source maps. V0 must contain exact accepted native
version/user-agent or init-payload pairs plus executable rejection fixtures.
Claude Task A1 must prove the pinned SDK JS/assets load from the built sidecar
without redistributing optional platform executables, and a named human must
record the Claude use/legal/package go decision. If any item is absent, stop
that provider's real registration: keep its existing `unavailableProvider`
placeholder and sanitized setup status. Do not create a temporary adapter,
range allowlist, or experimental fallback.

- [ ] **Step 1: Record the immutable preflight evidence**

```bash
rtk git status --short --branch
rtk git log --oneline --decorate -30
rtk rg -n "849bac8946c40420174b4187e36fcf17b5ea7cc4|678157acaa819d5510adfe359abb5d0392cfe461|0.3.170|legal|go/no-go|approved" docs/provider-provenance.md docs/provider-native-version-matrix.md THIRD_PARTY_NOTICES.md third_party
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/compatibility/*.test.ts sidecar/src/providers/claude/ClaudePackaging.test.ts
```

Expected: every artifact exists, exact pins match the adapter plans, both
compatibility fixture pairs execute, packaging feasibility passes, and the
Claude decision is explicit. Any missing file/result is a stop, not a skipped
gate.

- [ ] **Step 2: Merge only reviewed provider-local commits and keep placeholders**

```bash
rtk git merge --no-ff integration/multi-provider-codex
rtk git merge --no-ff integration/multi-provider-claude
rtk git diff --check origin/main...HEAD
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/*.test.ts sidecar/src/providers/claude/*.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run sidecar:build
rtk mise exec node@22 -- npm run quality:file-size
```

Expected: provider-local suites pass while the registry still resolves Codex
and Claude through the unavailable placeholders. The merge commits are the
commit boundary; do not make a registration commit in this task.

### Task 2: Atomically converge canonical renderer configuration, Settings, and composer

**Files:**

- Create: `src/features/providers/providerState.ts`
- Create: `src/features/providers/providerState.test.ts`
- Create: `src/features/providers/providerPreferences.ts`
- Create: `src/features/providers/providerPreferences.test.ts`
- Create: `src/features/providers/ProviderStore.tsx`
- Create: `src/features/providers/ProviderSettings.tsx`
- Create: `src/features/providers/ProviderSettings.test.ts`
- Create: `src/features/providers/ProviderStatusCard.tsx`
- Create: `src/features/providers/ProviderStatusCard.test.ts`
- Create: `src/features/providers/ProviderPicker.tsx`
- Create: `src/features/providers/ProviderPicker.test.ts`
- Create: `src/features/providers/ProviderModelSelector.tsx`
- Create: `src/features/providers/ProviderModelSelector.test.ts`
- Create: `src/features/providers/ProviderBadge.tsx`
- Create: `src/features/providers/DroidMissionConfiguration.tsx`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/commands.test.ts`
- Modify: `src/main.tsx`
- Modify: `src/hooks/useStore.tsx`
- Modify: `src/hooks/useStoreAutonomy.test.ts`
- Modify: `src/hooks/useStoreComposerSeed.test.ts`
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/components/SettingsPanel.test.ts`
- Modify: `src/lib/settingsSearch.ts`
- Modify: `src/lib/settingsSearch.test.ts`
- Modify: `src/components/PromptInput.tsx`
- Modify: `src/components/PromptInput.test.ts`
- Modify: `src/components/SidebarSessionRow.tsx`
- Modify: `src/components/SidebarSessionRow.test.ts`
- Modify: `src/components/ChatView.tsx`
- Modify: `src/components/chatViewState.ts`
- Modify: `src/components/chatViewState.test.ts`
- Modify: `src/components/RightPanel.tsx`
- Modify: `src/components/RightPanel.test.ts`
- Delete: `src/components/ModelSelectorPopover.tsx`
- Delete: `src/components/ModelSelectorPopover.test.ts`

**Interfaces:** Both bridge mirrors and every renderer producer/consumer use
these exact canonical types from the foundation, verbatim:

```ts
export interface ProviderSelection {
  providerInstanceId: ProviderInstanceId;
  modelId: string;
  options: Record<string, string | number | boolean>;
}

export interface SessionConfiguration {
  providerSelection: ProviderSelection;
  interactionMode: SessionInteractionMode;
  autonomy: Autonomy;
}

export interface DroidAgentConfiguration {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface DroidMissionConfiguration {
  worker: DroidAgentConfiguration;
  validator: DroidAgentConfiguration;
}
```

`SessionSummary` has exactly one required
`configuration: SessionConfiguration` and optional
`droidMissionConfiguration?: DroidMissionConfiguration`. It has no top-level
`providerDriverKind`, `providerInstanceId`, `modelId`, `reasoningEffort`,
`interactionMode`, `autonomy`, `workerModelId`, `workerReasoningEffort`,
`validatorModelId`, or `validatorReasoningEffort`. Child summaries keep their
existing Droid-only fields.

Create and update commands are exactly:

```ts
type CreateSessionCommand = {
  type: 'session.create';
  clientRef: string;
  cwd?: string;
  title: string;
  goal: string;
  sessionPurpose: SessionPurpose;
  configuration: SessionConfiguration;
  droidMissionConfiguration?: DroidMissionConfiguration;
};

type UpdateSessionSettingsCommand = {
  type: 'session.updateSettings';
  appSessionId: string;
  configuration: SessionConfiguration;
};
```

`session.updateSettings` rejects any provider-instance change. It validates the
whole replacement configuration, captures it as next-turn state, and does not
eagerly mutate a live provider turn. `droidMissionConfiguration` is separate,
valid only for Droid AGI sessions, and is never smuggled through provider
options or `session.updateSettings`.

`ProviderStore` owns provider snapshots/order, targeted refresh, provider
defaults, independent provider drafts, preference decode/reset state, and a
`clientRef` create lock. The sole preferences key is
`droidex-provider-preferences-v1`; never read, migrate, or delete old global
model/default keys. A malformed record blocks creation and exposes an explicit
`providerPreferences.reset()` action that deletes only the v1 key and writes a
fresh validated Droid-default record. Missing selected models remain stale and
block create until the user chooses a replacement.

Settings exposes linked search entries and stable anchors for Providers plus
Droid/Codex/Claude cards. Each card shows sanitized readiness/version/account
or billing route, a compile-time setup/recovery link, targeted refresh, exact
capabilities, model/options/mode/autonomy defaults, stale replacement, and the
explicit reset action. Unsupported values are absent or disabled with a reason.

The composer captures and locks the complete configuration synchronously before
any cwd/provider await. New drafts show provider and scoped model/options;
existing sessions show a locked provider badge. “Use another provider” opens a
new draft. Settings changes affect later drafts only. Droid Mission worker and
validator controls use `DroidMissionConfiguration` and appear only for Droid
AGI. Sidebar/chat badges compare provider identity; unrelated provider refreshes
must not rerender the active transcript.

- [ ] **Step 1: Write the failing hard-cut/state/Settings/composer tests**

Assert protocol mirror equality; exact `SessionSummary.configuration`; verbatim
create/update payloads; immutable update provider; captured next-turn settings;
no legacy fields; Droid Mission separation; Droid default; provider-scoped
equal model IDs; independent drafts; linked Settings search; targeted refresh;
malformed preference reset; stale model blocking; synchronous create lock;
mismatched settlement; locked live badge; “Use another provider”; and no
unrelated-refresh rerender.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test src/features/providers/providerState.test.ts src/features/providers/providerPreferences.test.ts src/features/providers/ProviderSettings.test.ts src/features/providers/ProviderStatusCard.test.ts src/features/providers/ProviderPicker.test.ts src/features/providers/ProviderModelSelector.test.ts src/lib/commands.test.ts src/lib/settingsSearch.test.ts src/hooks/useStoreAutonomy.test.ts src/hooks/useStoreComposerSeed.test.ts src/components/SettingsPanel.test.ts src/components/PromptInput.test.ts src/components/SidebarSessionRow.test.ts src/components/chatViewState.test.ts src/components/RightPanel.test.ts
```

- [ ] **Step 3: Implement one canonical renderer cut and delete the old picker**

Move all affected renderer state, Settings, and composer consumers in this same
working tree change. Do not commit aliases, optional nested configuration,
top-level mirrors, temporary selectors, or two preference keys.

- [ ] **Step 4: Validate and commit the atomic cut**

```bash
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run quality:file-size
rtk git add -A src/features/providers src/types/bridge.ts src/lib/commands.ts src/lib/commands.test.ts src/main.tsx src/hooks/useStore.tsx src/hooks/useStoreAutonomy.test.ts src/hooks/useStoreComposerSeed.test.ts src/components/SettingsPanel.tsx src/components/SettingsPanel.test.ts src/lib/settingsSearch.ts src/lib/settingsSearch.test.ts src/components/PromptInput.tsx src/components/PromptInput.test.ts src/components/SidebarSessionRow.tsx src/components/SidebarSessionRow.test.ts src/components/ChatView.tsx src/components/chatViewState.ts src/components/chatViewState.test.ts src/components/RightPanel.tsx src/components/RightPanel.test.ts src/components/ModelSelectorPopover.tsx src/components/ModelSelectorPopover.test.ts sidecar/src/protocol.ts
rtk git commit -m "feat(providers): converge configuration and renderer settings"
```

### Task 3: Complete provider-neutral approvals, questions, and plan review

**Files:**

- Modify: `sidecar/src/providers/providerInteractions.ts`
- Modify: `sidecar/src/SessionInteractions.ts`
- Modify: `sidecar/src/SessionInteractions.test.ts`
- Modify: `sidecar/src/SessionManager.interactions.test.ts`
- Modify: `sidecar/src/providers/droid/DroidInteractions.ts`
- Modify: `sidecar/src/providers/droid/DroidInteractions.test.ts`
- Modify: `sidecar/src/providers/codex/CodexInteractions.ts`
- Modify: `sidecar/src/providers/codex/CodexInteractions.test.ts`
- Modify: `sidecar/src/providers/claude/ClaudeInteractions.ts`
- Modify: `sidecar/src/providers/claude/ClaudeInteractions.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/commands.test.ts`
- Modify: `src/hooks/useStore.tsx`
- Create: `src/hooks/useStoreInteractions.test.ts`
- Modify: `src/components/AskUserModal.tsx`
- Create: `src/components/AskUserModal.test.ts`
- Modify: `src/components/PermissionInline.tsx`
- Create: `src/components/PermissionInline.test.ts`
- Modify: `src/components/PlanApprovalInline.tsx`
- Create: `src/components/PlanApprovalInline.test.ts`
- Modify: `src/components/PromptInput.test.ts`
- Modify: `src/App.tsx`

**Interfaces:** Delete `PermissionRequest.raw` from both bridge mirrors and all
renderer state. Approval bridge data is bounded sanitized
`kind/title/detail/plan/options` only.

Questions use exact provider keys and arrays end-to-end:

```ts
export interface SessionQuestion {
  appSessionId: string;
  requestId: string;
  questions: {
    key: string;
    prompt: string;
    options: string[];
    multiSelect: boolean;
  }[];
}

type QuestionRespondCommand = {
  type: 'question.respond';
  appSessionId: string;
  requestId: string;
  response:
    | { status: 'answered'; answers: Record<string, string[]> }
    | { status: 'cancelled' };
};
```

Never use display index or rewritten prompt as identity. `AskUserModal` stores
`Record<string, string[]>`, renders radio-like selection for
`multiSelect:false`, checkbox-like toggles for `multiSelect:true`, supports a
custom text answer as a one-element array, requires every question to have at
least one nonempty answer, preserves question order, and sends one exact-keyed
map. Cancel sends only `{status:'cancelled'}` and clears only the matching
request. Codex preserves native IDs and array answers; Claude uses the full
nonempty question text as the exact key and rejects duplicates/empty keys.

Plan review is separate from permission state:

```ts
export interface SessionPlanReview {
  appSessionId: string;
  requestId: string;
  plan: string;
}

export type PlanReviewDecision =
  | { decision: 'implement' }
  | { decision: 'iterate'; feedback: string }
  | { decision: 'cancel' };

type PlanReviewRespondCommand = {
  type: 'planReview.respond';
  appSessionId: string;
  requestId: string;
  decision: PlanReviewDecision;
};
```

`pendingPermission`, `pendingQuestion`, and `pendingPlanReview` are separately
owned, keyed/cleared by canonical app-session plus request identity, and cancel
on interrupt, close, crash, replacement, and shutdown. `PermissionInline`
uses provider-neutral copy and only the choices supported by the bound
snapshot. `PlanApprovalInline` renders all three visible decisions:
Implement, Keep iterating, and Cancel. Implement transitions the next
configuration to auto and steers a live turn or starts a later normal-mode turn;
Iterate requires nonempty feedback, keeps spec, and steers live or starts the
next plan turn; Cancel performs neither send nor mode change. Claude
`ExitPlanMode` stays nonblocking and is never held as a fake native callback.

- [ ] **Step 1: Write failing interaction bridge, state, UI, and adapter tests**

Cover raw-field absence; same native request ID in three providers; bounded
approval fields; every approval outcome; exact question keys; scalar and
multiselect array answers; custom answer; duplicate/empty Claude keys; cancel;
wrong-session/request no-op; Implement/Iterate/Cancel; plan dedupe; live steer
versus idle next turn; and cleanup on interrupt/close/crash/replacement/shutdown.

- [ ] **Step 2: Run the failing interaction tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionInteractions.test.ts sidecar/src/SessionManager.interactions.test.ts sidecar/src/providers/droid/DroidInteractions.test.ts sidecar/src/providers/codex/CodexInteractions.test.ts sidecar/src/providers/claude/ClaudeInteractions.test.ts src/lib/commands.test.ts src/hooks/useStoreInteractions.test.ts src/components/AskUserModal.test.ts src/components/PermissionInline.test.ts src/components/PlanApprovalInline.test.ts src/components/PromptInput.test.ts
```

- [ ] **Step 3: Implement the hard cut, validate, and commit**

```bash
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run quality:file-size
rtk git add sidecar/src/providers/providerInteractions.ts sidecar/src/SessionInteractions.ts sidecar/src/SessionInteractions.test.ts sidecar/src/SessionManager.interactions.test.ts sidecar/src/providers/droid/DroidInteractions.ts sidecar/src/providers/droid/DroidInteractions.test.ts sidecar/src/providers/codex/CodexInteractions.ts sidecar/src/providers/codex/CodexInteractions.test.ts sidecar/src/providers/claude/ClaudeInteractions.ts sidecar/src/providers/claude/ClaudeInteractions.test.ts sidecar/src/protocol.ts src/types/bridge.ts src/lib/commands.ts src/lib/commands.test.ts src/hooks/useStore.tsx src/hooks/useStoreInteractions.test.ts src/components/AskUserModal.tsx src/components/AskUserModal.test.ts src/components/PermissionInline.tsx src/components/PermissionInline.test.ts src/components/PlanApprovalInline.tsx src/components/PlanApprovalInline.test.ts src/components/PromptInput.test.ts src/App.tsx
rtk git commit -m "feat(interactions): complete provider-neutral review flows"
```

### Task 4: Add visible failed-start retry and removal controls

**Files:**

- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/commands.test.ts`
- Modify: `src/hooks/useStore.tsx`
- Create: `src/hooks/useStoreFailedSessions.test.ts`
- Create: `src/features/providers/FailedSessionActions.tsx`
- Create: `src/features/providers/FailedSessionActions.test.ts`
- Modify: `src/components/ChatView.tsx`
- Modify: `src/components/SidebarSessionRow.tsx`
- Modify: `src/components/SidebarSessionRow.test.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/SessionContextMenu.tsx`
- Modify: `src/components/SessionContextMenu.test.ts`

**Interfaces:** Consume the foundation's exact production commands/events; do
not alias them to close, resume, archive, or local retry:

```ts
type FailedSessionCommand =
  | { type: 'session.retryStart'; appSessionId: string }
  | { type: 'session.removeFailed'; appSessionId: string };

type FailedSessionEvent =
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.removed'; appSessionId: string };
```

Add exact command helpers `retrySessionStart(appSessionId)` and
`removeFailedSession(appSessionId)`. Store state tracks the in-flight operation
per app session and clears it only on that session's `session.updated`,
`session.removed`, or structured failure. A failed retry leaves the same
visible row/action. Removal deletes the matching summary, transcript window,
restore/paging state, metadata, notes, utility state, and selection; it chooses
the existing deterministic next visible session without touching any other row.

`FailedSessionActions` appears in the failed chat body and the sidebar row.
`SessionContextMenu.tsx` is an unconditional owner in this task: for a failed
non-live session it shows “Retry start” and “Remove failed session”; removal
requires confirmation. Remove the native provider-session ID/link rows because
provider native identity is sidecar-only. No UI control retries with current
defaults or another provider.

- [ ] **Step 1: Write failing command/reducer/visible-control tests**

Assert exact app-session targeting, operation isolation, duplicate-click
disablement, retry failure persistence, successful update, complete removal
cleanup, deterministic next selection, confirmation, keyboard labels, no
fallback create, and unconditional context-menu coverage.

- [ ] **Step 2: Run failing tests, implement, and validate**

```bash
rtk mise exec node@22 -- node --import tsx --test src/lib/commands.test.ts src/hooks/useStoreFailedSessions.test.ts src/features/providers/FailedSessionActions.test.ts src/components/SidebarSessionRow.test.ts src/components/SessionContextMenu.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run quality:file-size
```

- [ ] **Step 3: Commit the complete visible recovery slice**

```bash
rtk git add sidecar/src/protocol.ts src/types/bridge.ts src/lib/commands.ts src/lib/commands.test.ts src/hooks/useStore.tsx src/hooks/useStoreFailedSessions.test.ts src/features/providers/FailedSessionActions.tsx src/features/providers/FailedSessionActions.test.ts src/components/ChatView.tsx src/components/SidebarSessionRow.tsx src/components/SidebarSessionRow.test.ts src/components/Sidebar.tsx src/components/SessionContextMenu.tsx src/components/SessionContextMenu.test.ts
rtk git commit -m "feat(sessions): expose failed-start recovery"
```

### Task 5: Gate every exact renderer control owner by provider capability

**Files:**

- Create: `src/features/providers/providerCapabilities.ts`
- Create: `src/features/providers/providerCapabilities.test.ts`
- Modify: `src/components/PromptInput.tsx`
- Modify: `src/components/PromptInput.test.ts`
- Modify: `src/components/ComposerMenu.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/SidebarSessionRow.tsx`
- Modify: `src/components/SidebarSessionRow.test.ts`
- Modify: `src/components/ChatView.tsx`
- Modify: `src/components/RightPanel.tsx`
- Modify: `src/components/RightPanel.test.ts`
- Modify: `src/components/MissionControl.tsx`
- Modify: `src/components/SessionContextMenu.tsx`
- Modify: `src/components/SessionContextMenu.test.ts`
- Modify: `src/components/McpServersSettings.tsx`
- Modify: `src/components/McpServersSettings.test.ts`
- Modify: `src/components/browser/BrowserWorkspace.tsx`
- Modify: `src/components/browser/BrowserToolbar.tsx`
- Modify: `src/components/browser/NativeBrowserSurface.tsx`
- Modify: `src/components/browser/NativeBrowserSurface.test.ts`
- Modify: `src/components/browser/BrowserFocusWorkspace.tsx`
- Modify: `src/App.tsx`
- Modify: `src/hooks/useStore.tsx`
- Modify: `src/hooks/useStoreContextCompaction.test.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/commands.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.unsupportedCommand.test.ts`
- Modify: `sidecar/src/SessionManager.mcp.test.ts`
- Modify: `sidecar/src/SessionManager.browserRouting.test.ts`

`providerCapabilities.ts` is a pure selector returning
`{ visibility: 'show' | 'disable' | 'hide'; reason?: string }`; it never mutates
state. Wire these exact owners:

- `PromptInput.tsx`/`ComposerMenu.tsx`: `/mission`, `/compact`, Spec, autonomy,
  skills/slash results, send/steer, stop, model/options, and attachments.
- `McpServersSettings.tsx`: MCP list/add/remove/toggle/authenticate and tool use.
- `MissionControl.tsx`: workers, validators, child actions, and AGI controls.
- `RightPanel.tsx`: model/options, context, and compaction.
- `BrowserWorkspace.tsx`, `BrowserToolbar.tsx`, `NativeBrowserSurface.tsx`,
  `BrowserFocusWorkspace.tsx`, and `App.tsx`: browser open/use/design mode and
  the Context/utility entry points.
- `PromptInput.tsx`, `ChatView.tsx`, `Sidebar.tsx`, `SidebarSessionRow.tsx`, and
  `SessionContextMenu.tsx`: send/steer/stop/resume/close and every currently
  rendered session action. The context menu is always included; app-owned
  pin/rename/archive/export remain available while provider-native actions obey
  capabilities. Rewind and fork have no current rendered owner, so keep them
  absent and enforce their capabilities only in command decoding/sidecar routing;
  do not add fake controls.

Codex/Claude never expose Droid Mission controls. Missing capabilities are
rejected in `SessionManager` before provider mutation with exact
`providerInstanceId`, operation, capability, and recovery action. If a bound
provider becomes unavailable, keep the binding and show recovery/close; never
substitute Droid. Catalogs and skills are keyed by provider instance rather
than provider session ID, so equal names never leak between providers.

- [ ] **Step 1: Write one complete capability snapshot per driver plus owner tests**

Cover every listed control for Droid/Codex/Claude and unavailable instances,
including visible disabled reasons, hidden Droid-only controls, provider-keyed
skills/catalogs, and sidecar rejection before adapter calls.

- [ ] **Step 2: Implement the exact gates and validate**

```bash
rtk mise exec node@22 -- node --import tsx --test src/features/providers/providerCapabilities.test.ts src/components/PromptInput.test.ts src/components/RightPanel.test.ts src/components/SessionContextMenu.test.ts src/components/McpServersSettings.test.ts src/components/browser/NativeBrowserSurface.test.ts src/hooks/useStoreContextCompaction.test.ts src/lib/commands.test.ts sidecar/src/SessionManager.unsupportedCommand.test.ts sidecar/src/SessionManager.mcp.test.ts sidecar/src/SessionManager.browserRouting.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run quality:file-size
```

- [ ] **Step 3: Commit only the named capability owners**

```bash
rtk git add src/features/providers/providerCapabilities.ts src/features/providers/providerCapabilities.test.ts src/components/PromptInput.tsx src/components/PromptInput.test.ts src/components/ComposerMenu.tsx src/components/Sidebar.tsx src/components/SidebarSessionRow.tsx src/components/SidebarSessionRow.test.ts src/components/ChatView.tsx src/components/RightPanel.tsx src/components/RightPanel.test.ts src/components/MissionControl.tsx src/components/SessionContextMenu.tsx src/components/SessionContextMenu.test.ts src/components/McpServersSettings.tsx src/components/McpServersSettings.test.ts src/components/browser/BrowserWorkspace.tsx src/components/browser/BrowserToolbar.tsx src/components/browser/NativeBrowserSurface.tsx src/components/browser/NativeBrowserSurface.test.ts src/components/browser/BrowserFocusWorkspace.tsx src/App.tsx src/hooks/useStore.tsx src/hooks/useStoreContextCompaction.test.ts src/lib/commands.ts src/lib/commands.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.unsupportedCommand.test.ts sidecar/src/SessionManager.mcp.test.ts sidecar/src/SessionManager.browserRouting.test.ts
rtk git commit -m "feat(providers): gate exact product controls"
```

### Task 6: Make optional provider setup discoverable without credentials

**Files:**

- Modify: `src/components/onboarding/stepFlow.ts`
- Modify: `src/components/onboarding/stepFlow.test.ts`
- Modify: `src/components/onboarding/OnboardingWizard.tsx`
- Create: `src/components/onboarding/steps/ProviderSetupStep.tsx`
- Create: `src/components/onboarding/steps/ProviderSetupStep.test.ts`
- Modify: `src/components/onboarding/steps/SignInStep.tsx`
- Modify: `src/components/onboarding/steps/SystemStep.tsx`
- Modify: `src/components/onboarding/steps/DoneStep.tsx`
- Modify: `src/hooks/useOnboarding.ts`
- Modify: `src/hooks/useOnboarding.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/desktop.ts`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `electron/preload.test.cjs`
- Modify: `electron/mainRegression.test.cjs`

Keep Droid-first onboarding and add `providers` after official Droid sign-in.
Codex and Claude are optional and may be deferred through a direct linked route
to the exact Settings card. Reuse sanitized snapshots and compile-time setup
links. Delete renderer/Electron `getApiKey`, `setApiKey`, `clearApiKey`, API-key
UI, and `connect.apiKey`; old encrypted files remain untouched and unread.
Returning-user provider discovery remains deferred with
`requestIdleCallback({timeout:1500})` or the existing 300 ms fallback so
session list/history win first paint.

- [ ] **Step 1: Add failing flow, secret-surface, link, and deferral tests**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test src/components/onboarding/stepFlow.test.ts src/components/onboarding/steps/ProviderSetupStep.test.ts src/hooks/useOnboarding.test.ts
rtk mise exec node@22 -- node --test electron/preload.test.cjs electron/mainRegression.test.cjs
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run electron:check
rtk mise exec node@22 -- npm run quality:file-size
rtk git add src/components/onboarding/stepFlow.ts src/components/onboarding/stepFlow.test.ts src/components/onboarding/OnboardingWizard.tsx src/components/onboarding/steps/ProviderSetupStep.tsx src/components/onboarding/steps/ProviderSetupStep.test.ts src/components/onboarding/steps/SignInStep.tsx src/components/onboarding/steps/SystemStep.tsx src/components/onboarding/steps/DoneStep.tsx src/hooks/useOnboarding.ts src/hooks/useOnboarding.test.ts src/App.tsx src/lib/desktop.ts electron/main.cjs electron/preload.cjs electron/preload.test.cjs electron/mainRegression.test.cjs
rtk git commit -m "feat(onboarding): link optional provider setup"
```

### Task 7: Stage real adapter registration only after all entry gates pass

**Files:**

- Modify: `sidecar/src/providers/ProviderRegistry.ts`
- Modify: `sidecar/src/providers/ProviderRegistry.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/commands.test.ts`

Register a real adapter only when Task 1 has written evidence for P0, V0,
provider-local deterministic tests, provenance/license completeness, Claude
legal approval, and packaged-runtime feasibility. A provider that fails any
gate keeps the existing `unavailableProvider` entry with its closed setup
action; the other provider may register independently. Runtime readiness may
truthfully be unavailable/unauthenticated after registration. Do not describe a
provider as ready or supported until authenticated and signed packaged smoke
passes at release time.

Registry order is exactly Droid, Codex, Claude. Add `providers.list` and targeted
`provider.refresh`; emit `providers.snapshot` and `provider.updated`. Refresh is
single-flight per provider instance, changes only that snapshot/revision, and
never touches active bindings. `session.create` routes the exact nested
configuration; all session commands route from the immutable persisted instance.

- [ ] **Step 1: Add failing registry/routing tests with independent gate cases**

Cover stable order, placeholder retention, independently eligible registration,
duplicate refresh coalescing, provider-scoped equal model IDs, crash isolation,
exact create routing, immutable active bindings, and protocol mirror equality.

- [ ] **Step 2: Implement staged registration, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts src/lib/commands.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run quality:file-size
rtk git add sidecar/src/providers/ProviderRegistry.ts sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/protocol.ts src/types/bridge.ts src/lib/commands.ts src/lib/commands.test.ts
rtk git commit -m "feat(providers): stage eligible adapter registration"
```

### Task 8: Prove simultaneous sessions and preserve exact loading invariants

**Files:**

- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionTimeline.test.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `src/hooks/useStoreHistoryPaging.test.ts`
- Modify: `src/hooks/useStoreTranscriptWindow.test.ts`
- Modify: `src/hooks/useStoreSessionRestore.test.ts`
- Modify: `src/components/ConversationTimeline.test.ts`
- Create: `sidecar/src/providers/testing/fixtures/fake-droid.mjs`
- Create: `sidecar/src/providers/testing/fixtures/fake-codex-app-server.mjs`
- Create: `sidecar/src/providers/testing/fixtures/fake-claude.mjs`
- Create: `sidecar/src/providers/testing/fixtures/provider-scenarios.json`
- Create: `tests/smoke/electronProviders.smoke.spec.ts`
- Create: `playwright.providers-smoke.config.ts`
- Modify: `package.json`

The dedicated Playwright config is required because
`playwright.config.ts` has `testDir: './tests/integration'` and therefore does
not discover `tests/smoke`. Add this exact script:

```json
{
  "test:smoke:electron-providers": "npm run build && playwright test --config=playwright.providers-smoke.config.ts"
}
```

`playwright.providers-smoke.config.ts` uses `testDir: './tests/smoke'`, exact
`testMatch: 'electronProviders.smoke.spec.ts'`, one worker, no parallelism, and
the deterministic fixture paths above.

Required scenarios: all three providers run simultaneously; equal native/model
IDs remain isolated; interleaved events target exact app sessions; a refresh or
crash affects only its provider; restart lazily resumes only the exact adapter;
interactions settle; shutdown cleans every process/callback; no sentinel secret
serializes.

Lock these current invariants in the named tests: sidecar explicit page cap
1,600 and default 400; renderer older-history request 240 and 2,400 px prefetch;
eight-frame scroll-anchor retry; timeline auto-prime 12; scroll snapshot
capacity 100; bridge batch 16 ms; stream coalesce 40 ms/64 KiB; sidebar display
page five; released-tail repair cap 1,600. Snapshot events must not change
transcript/history/loading state or initiate paging.

- [ ] **Step 1: Add failing concurrent, paging, and loading tests**
- [ ] **Step 2: Fix only convergence defects; do not redesign paging**
- [ ] **Step 3: Run the dedicated deterministic smoke and commit**

```bash
rtk mise exec node@22 -- npm --prefix sidecar run test
rtk mise exec node@22 -- npm run test
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run electron:check
rtk mise exec node@22 -- npm run test:smoke:electron-providers
rtk mise exec node@22 -- npm run quality:file-size
rtk git add sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionTimeline.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts src/hooks/useStoreHistoryPaging.test.ts src/hooks/useStoreTranscriptWindow.test.ts src/hooks/useStoreSessionRestore.test.ts src/components/ConversationTimeline.test.ts sidecar/src/providers/testing/fixtures/fake-droid.mjs sidecar/src/providers/testing/fixtures/fake-codex-app-server.mjs sidecar/src/providers/testing/fixtures/fake-claude.mjs sidecar/src/providers/testing/fixtures/provider-scenarios.json tests/smoke/electronProviders.smoke.spec.ts playwright.providers-smoke.config.ts package.json
rtk git commit -m "test(providers): prove concurrent loading isolation"
```

### Task 9: Package provider runtimes and smoke the unpacked platform artifact

**Files:**

- Modify: `electron-builder.config.cjs`
- Modify: `electron/builderConfig.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/mainRegression.test.cjs`
- Modify: `electron/sidecar.cjs`
- Modify: `electron/sidecar.test.cjs`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.shutdownOrder.test.ts`
- Modify: `sidecar/src/SessionManager.teardown.test.ts`
- Create: `tests/smoke/packagedProviders.smoke.spec.ts`
- Create: `playwright.packaged-providers-smoke.config.ts`
- Modify: `package.json`
- Modify: `docs/releasing.md`

Preserve the self-contained sidecar bundle. Prove external Droid/Codex/Claude
discovery, Claude SDK JS/asset resolution, and crash isolation. Assert all
Droid, Codex, Claude, and optional Claude platform executables are absent from
the artifact unless an explicit redistribution approval is recorded. Test
fixtures never ship.

Add exact platform packaging and packaged-smoke scripts; a normal Vite/root
`build` is not a packaged smoke prerequisite:

```json
{
  "pack:providers:dir:mac": "npm run build && electron-builder --dir --mac --publish never -c electron-builder.config.cjs",
  "test:smoke:packaged-providers:mac": "npm run pack:providers:dir:mac && playwright test --config=playwright.packaged-providers-smoke.config.ts"
}
```

The packaged config uses `testDir: './tests/smoke'`, exact
`testMatch: 'packagedProviders.smoke.spec.ts'`, one worker, and launches the
unpacked `.app` produced by the preceding `electron-builder --dir --mac`
command, never `dist/index.html` or the source Electron entry.

Shutdown remains one bounded operation: `SessionManager` closes live provider
sessions concurrently; the Electron supervisor owns one monotonic six-second
deadline shared by repeated stop requests; `before-quit` waits for the same
promise once; expiry terminates the complete sidecar/provider process tree
without a second per-provider window. Deterministic tests start all three fake
process trees and prove graceful completion or exact-once forced termination
with no surviving descendant.

- [ ] **Step 1: Add failing builder, CLI-absence, asset, process-tree, and packaged tests**
- [ ] **Step 2: Implement the smallest packaging changes and run the platform smoke**

```bash
rtk mise exec node@22 -- node --test electron/builderConfig.test.cjs electron/sidecar.test.cjs electron/mainRegression.test.cjs
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionManager.shutdownOrder.test.ts sidecar/src/SessionManager.teardown.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run electron:check
rtk mise exec node@22 -- npm run test:smoke:packaged-providers:mac
rtk mise exec node@22 -- npm run quality:file-size
```

- [ ] **Step 3: Commit packaging and the dedicated smoke path**

```bash
rtk git add electron-builder.config.cjs electron/builderConfig.test.cjs electron/main.cjs electron/mainRegression.test.cjs electron/sidecar.cjs electron/sidecar.test.cjs sidecar/src/SessionManager.ts sidecar/src/SessionManager.shutdownOrder.test.ts sidecar/src/SessionManager.teardown.test.ts tests/smoke/packagedProviders.smoke.spec.ts playwright.packaged-providers-smoke.config.ts package.json docs/releasing.md
rtk git commit -m "build(providers): verify packaged provider runtimes"
```

### Task 10: Complete docs, provenance, licenses, workflows, and release gates

**Files:**

- Create: `docs/providers.md`
- Modify: `docs/provider-provenance.md`
- Modify: `docs/provider-native-version-matrix.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `third_party/t3-code/LICENSE`
- Modify: `third_party/codex-app-server/LICENSE`
- Modify: `third_party/codex-app-server/NOTICE`
- Modify: `third_party/claude-agent-sdk/LICENSE.md`
- Create: `tools/check-provider-provenance.mjs`
- Create: `tools/check-provider-provenance.test.mjs`
- Create: `tools/check-provider-licenses.mjs`
- Create: `tools/check-provider-licenses.test.mjs`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/architecture.md`
- Modify: `docs/runbooks.md`
- Modify: `docs/releasing.md`
- Modify: `docs/deployment-observability.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-macos.yml`
- Modify: `.github/workflows/security-review.yml`
- Generate: command/environment docs only with `npm run docs:generate`

Use the product statement: “One DROIDEX interface. Droid by default. Choose
Droid, Codex, or Claude for each new session and run them together.” Document
exact setup/recovery links, immutable binding, explicit failed-session recovery,
settings reset, no history migration, no credential capture, external CLI
requirements, unsupported capabilities, and packaged troubleshooting.

`third_party/codex-app-server/LICENSE` contains the complete unmodified
Apache-2.0 license text; `NOTICE` contains every applicable upstream notice and
the exact official ref. Keep the complete T3 MIT license and reviewed Claude
license/legal reference. Provenance maps every substantially derived file and
requires its header. Checkers fail on missing/full-ref mismatch, stale source
map/header, incomplete or altered license/notice, missing human Claude decision,
and accidental packaging of any Droid/Codex/Claude/optional Claude platform
executable.

Add exact scripts:

```json
{
  "quality:provenance": "node tools/check-provider-provenance.mjs",
  "quality:licenses": "node tools/check-provider-licenses.mjs"
}
```

`.github/workflows/ci.yml` runs deterministic provider tests plus both checker
scripts. `.github/workflows/security-review.yml` runs both checkers and the
all-provider executable-absence artifact test. `.github/workflows/release-macos.yml`
runs the explicit macOS `electron-builder --dir` packaged smoke before signing,
then preserves the existing signed distribution flow. None of these workflows
claims authenticated provider success without an authorized secret-bearing
runner.

`docs/releasing.md` records separate opt-in authenticated Droid, Codex, Claude,
and simultaneous-provider procedures using official local login only, plus the
signed installed-app procedure: build/sign, install outside the source tree,
refresh all Settings cards, create/send/interrupt/resume each provider, run all
three simultaneously, exercise approval/question/plan review and failed-start
retry/removal, quit, and verify no sidecar/provider descendants. Missing auth or
signing is reported as pending and blocks release/marketed readiness.

- [ ] **Step 1: Write failing checker and workflow-contract tests**

Test missing pins, altered full licenses/notices, absent derived headers,
incomplete source maps, missing legal decision, absent package scripts, wrong
workflow path/gate, and every prohibited packaged executable name.

- [ ] **Step 2: Add docs, exact licenses/notices, checkers, and workflow gates**
- [ ] **Step 3: Generate docs and run the complete local gate**

```bash
rtk mise exec node@22 -- node --test tools/check-provider-provenance.test.mjs tools/check-provider-licenses.test.mjs
rtk mise exec node@22 -- node -e "const p=require('./package.json').scripts; for (const n of ['quality:provenance','quality:licenses','test:smoke:electron-providers','pack:providers:dir:mac','test:smoke:packaged-providers:mac']) if (!p[n]) throw new Error('Missing script: '+n)"
rtk mise exec node@22 -- npm run docs:generate
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
```

- [ ] **Step 4: Commit locally; do not push**

```bash
rtk git add README.md .env.example docs/providers.md docs/provider-provenance.md docs/provider-native-version-matrix.md docs/architecture.md docs/runbooks.md docs/releasing.md docs/deployment-observability.md THIRD_PARTY_NOTICES.md third_party/t3-code/LICENSE third_party/codex-app-server/LICENSE third_party/codex-app-server/NOTICE third_party/claude-agent-sdk/LICENSE.md tools/check-provider-provenance.mjs tools/check-provider-provenance.test.mjs tools/check-provider-licenses.mjs tools/check-provider-licenses.test.mjs package.json .github/workflows/ci.yml .github/workflows/release-macos.yml .github/workflows/security-review.yml
rtk git commit -m "docs(providers): complete provenance and release gates"
```

## Final release evidence

The implementation is locally complete only after every deterministic gate
above passes. It is releasable and may be marketed as ready only after the
signed installed-app procedure and authenticated Droid, Codex, Claude, and
simultaneous-provider smokes are attached with exact app version, platform,
native versions, and pass/fail results. A pending manual gate remains a blocker;
it never triggers a fallback, placeholder removal, or readiness claim.

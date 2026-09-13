# Multi-provider sessions on origin/main: design and stacked-PR plan

Base: `providers/integration` == `origin/main` `f9a8c9f1`.
Reference branch `cursor/mp-harness-picker-330f` is read-only prior art. We merge nothing from it.


## 0. Decisions taken on 2026-09-13 (supersede anything below that conflicts)

- **PR order:** the neutral interactions port lands first (PR1), the provider binding second (PR2), the `ProviderSession` seam third (PR3). The seam's `Provider.create(input)` then takes a neutral `interactions` port from day one instead of Droid's handler pair, so the create path is touched once, not twice. Section 4 below is numbered one lower than this stack (its PR1 is this stack's PR3, and so on).
- **Contract grows additively.** PR3 ships only `Provider { kind, create, resume }` and `ProviderSession { provider, providerSessionId, resumeId?, stream, interrupt, close }`. `probe()` / `ProviderStatus` arrive with the registry in PR4; `ProviderCapabilities` and the lifecycle gates arrive in PR6 where a provider first needs them. Nothing speculative is merged.
- **Open questions answered:** (a) unsupported controls are hidden for non-Droid sessions; (b) the picker is an icon chip beside the model chip in the composer's existing idiom; (c) Claude and Codex models join the single existing model catalog; (d) reasoning effort uses a lossy per-provider table, unsupported values are simply absent from `supportedReasoningEfforts`; (e) Claude ships its first PR with `steer: false` (prompts queue), true mid-turn steering is a later PR; (f) Codex outside the reviewed CLI range reads as `unsupported` with a clear message.
- **Tests:** no new test files are planned. An agent may write a test while working, but it survives only if it protects a cross-provider contract; everything else is deleted before the PR opens.
- **Verification is the real CLI in the real app** for every PR from the first Claude PR on, plus the standing gates (typecheck, lint on touched files, existing suites, file-size, boundaries, knip for renderer PRs, perf replay/compare/gates for anything on the turn path).

---

## 1. Goal

A user picks Droid, Claude Code, or Codex in the composer before the first prompt. The session binds to that provider for life. The provider icon shows in the sidebar. Streaming text, reasoning and tool activity render in the **existing** transcript. Approvals and questions round-trip through the **existing** approval UI. Interrupt works. The session resumes, with scrollback, after app restart.

Droid is the default and behaves exactly as today at every commit in the stack.

## 2. Non-goals

- Cursor and Grok. No ACP transport (1,660 lines in the reference branch): Claude is an in-process SDK with no wire, Codex speaks its own non-JSON-RPC-2.0 NDJSON. There is no second consumer, so there is no abstraction to extract.
- Any storage rewrite. No `persistence/{DroidexDatabase,SessionStore,TranscriptStore}.ts`, no `sessionCanonical*.ts`, no canonical event envelope, no snapshot hard-cut. **No SQLite migration at all** (see §3.6).
- Child sessions, Mission Control, spec mode, rewind, fork, manual/auto compaction, browser, design-tool policy for non-Droid providers. All capability-gated off; Droid keeps all of them.
- New test files. Verification is typecheck, lint, existing suites green, knip, and the real CLI in the real app.

## 3. Architecture

### 3.1 What main already has (do not rebuild it)

Main is already seam-ready in two places the reference branch did not notice (the provider-agnostic event type and the object-identity stale-turn guard), which is why the reference branch is 13.2k lines and this stack is under 3k.

**Provider identity does not exist yet (corrected 2026-09-13).** An earlier draft of this section claimed `providerKind.ts`, `SessionSummary.provider` and `session.create.provider` were already on main; that was an uncommitted work-in-progress file read from a shared worktree, not main. PR 2 of the stack introduces them: `sidecar/src/providers/providerKind.ts` (`PROVIDER_KINDS = ['droid','claude','codex']`, `DEFAULT_PROVIDER`, `providerKind()`, `requireProviderKind()`, `assertProviderUnchanged()`), a required `SessionSummary.provider: ProviderKind` mirrored into `src/types/bridge.ts`, an optional `session.create.provider`, rejection of a provider change in `session.updateSettings`, and `provider: 'droid'` stamped by every summary builder (`buildCreatedSessionSummary`, `buildResumedSession`, `summarizeSessionFile`, session adoption). No database column: every session on disk today is Droid, and non-Droid sessions persist their binding in their own transcript head line (§3.6).

Consequences: **we use `ProviderKind`, not a new `HarnessId`.** New code lives under `sidecar/src/providers/` and `src/features/providers/`. After PR 2 the binding is stamped but not routed: `SessionLifecycle.create` still calls `d.runtime.createSession(...)` unconditionally, which PR 3 (the seam) replaces with `provider(kind).create(...)`.

**The event seam already exists and is already provider-agnostic.** `NormalizedEvent` (`sidecar/src/normalize.ts:75-88`) is `{transcript?, features?, progress?, missionState?, missionChild?, childSession?, tokens?, done?}` — nine fields, zero Droid types. `SessionEventFlow.applyNormalized` (`SessionEventFlow.ts:69-105`) consumes it and funnels into four injected sinks declared at `SessionEventFlow.ts:11-18`: `appendTranscript(TranscriptEvent)`, `flushTranscript`, `applySideEffects`, `recordUsage`. `applyStreamEvent` (`:33-43`) and `applyNotification` (`:45-66`) are thin Droid wrappers around it. Everything downstream — `SessionTimeline`, `HistoryPersistence`, the bridge batcher, the whole renderer transcript — is already provider-blind.

**Therefore: adapters emit `NormalizedEvent` directly.** We do not invent a parallel envelope. The reference branch's `providerEvents.ts` is 386 lines with 87 zod calls whose `transcript` payload is literally `Omit<TranscriptEvent,'id'|'appSessionId'|'sourceSessionId'|'seq'|'ts'>` — it re-wrapped main's own type and re-validated it at an in-process boundary. That is the single largest piece of waste in the reference branch and we decline all of it.

**Stale-turn safety already exists.** `isCurrentPrimarySession` (`SessionManager.ts:1296-1300`) compares `registry.getLive(id) === liveSession` by object identity; `target.isCurrent()` closures do the same for context/compaction (`SessionLifecycle.ts:186`). The reference branch's `runtimeGeneration` + `admitProviderRuntimeEvent` (~120 lines) is a second, weaker mechanism for a bug main already solves. Dropped.

**The turn loop is four lines.** `SessionManager.runPrimaryTurn` (`SessionManager.ts:1248-1294`):

```ts
const stream = liveSession.session.stream(prompt, { includePartialMessages: true });
for await (const ev of stream) {
  if (!this.isCurrentPrimarySession(liveSession)) break;
  this.eventFlow.applyStreamEvent(appSessionId, appSessionId, 'primary', ev);
}
```

`FactoryRuntime` is seven methods (`DroidRuntime.ts:89-97`); `FactorySession` is a 20-method `Pick<DroidSession,…>` plus `stream()` (`DroidRuntime.ts:57-87`). Main already factored the driver boundary; it just has one implementation.

### 3.2 Contract: `sidecar/src/providers/session.ts` (~95 lines)

```ts
import type { NormalizedEvent } from '../normalize.js';
import type { ProviderKind } from './providerKind.js';
import type { Autonomy, ContextStatsSnapshot, McpServerConfig,
              ModelInfo, ReasoningEffort, SessionInteractionMode } from '../protocol.js';

// Each boolean gates a branch that already exists in the lifecycle. Add one
// the day a provider differs on it; never add one speculatively.
export interface ProviderCapabilities {
  resume: boolean;          // resumeOnce can reattach after restart
  steer: boolean;           // mid-turn sendNow without interrupt-and-resend
  interrupt: boolean;
  approvals: boolean;
  questions: boolean;
  contextStats: boolean;    // SessionContext polling (explicit stats call)
  compaction: boolean;      // SessionCompaction.arm / subscribePrimary
  specMode: boolean;        // interactionMode 'spec'
  missionControl: boolean;  // interactionMode 'agi' + ChildSessions.attachParent
  reasoningStream: boolean;
}

export interface ProviderStatus {
  provider: ProviderKind;
  readiness: 'ready' | 'missing' | 'unauthenticated' | 'unsupported' | 'error';
  version?: string;
  accountLabel?: string;
  message?: string;
  models: ModelInfo[];                 // reuse protocol.ts ModelInfo verbatim
  capabilities: ProviderCapabilities;
}

export interface ProviderOpenInput {
  appSessionId: string;
  cwd: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  autonomy: Autonomy;
  interactionMode: SessionInteractionMode;
  mcpServers?: McpServerConfig[];
  interactions: ProviderInteractions;  // see 3.4
}

export interface ProviderSession {
  readonly provider: ProviderKind;
  readonly providerSessionId: string;  // native id; Claude pins it == appSessionId
  readonly resumeId?: string;          // only when it differs (Codex threadId)
  readonly capabilities: ProviderCapabilities;
  // The turn. Generator return == settled; throw == failed. No settlement event:
  // an async generator already *is* the turn lifecycle. Provider-specific stream
  // options (Droid's `includePartialMessages: true`) live inside the adapter.
  stream(prompt: string): AsyncGenerator<NormalizedEvent, void, undefined>;
  interrupt(): Promise<void>;
  contextStats(): Promise<ContextStatsSnapshot | undefined>;  // undefined when !capabilities.contextStats
  close(): Promise<void>;
}

export interface Provider {
  readonly kind: ProviderKind;
  probe(signal: AbortSignal): Promise<ProviderStatus>;
  create(input: ProviderOpenInput): Promise<ProviderSession>;
  resume(resumeId: string, input: ProviderOpenInput): Promise<ProviderSession>;
}
```

Rejected from the reference branch, with reasons:

| Reference-branch concept | Lines | Why out |
|---|---|---|
| `ProviderRuntimeEvent` + zod (`providerEvents.ts`) | 386 | `NormalizedEvent` already is it (§3.1). zod on the per-token hot path is pure cost; main measures that path (`telemetry/hotPathMetrics.ts`, `npm run perf:replay`). |
| `runtimeGeneration` / `admitProviderRuntimeEvent` | ~120 | Object-identity guard already exists (`SessionManager.ts:1296-1300`). |
| `turn.settled` + acceptance-only `startTurn` + `START_TURN_ACCEPTANCE_ONLY` assertion | ~40 | The `for await` loop ending or throwing already expresses settlement. |
| `SessionConfiguration` / `ProviderSelection` | ~60 + every call site | Main keeps `modelId`/`reasoningEffort`/`interactionMode`/`autonomy` flat (`protocol.ts:115-131`). A composite rewrites reads across `SessionManager` (2016 lines), `sessionHelpers`, `ModelSelectorPopover`, `useStore` for zero user-visible gain. |
| 23-boolean `ProviderCapabilities` | — | We need 10, each load-bearing. |
| 12-code `ProviderError` + 11 recovery actions | 91 | Main's channel is `ServerEvent {type:'error', code?, message}`. Two reference codes (`canonical_persistence_unavailable`, `reset_canonical_state`) exist only to serve the storage rewrite. |
| `ProviderRegistry` class | 449 | Three providers, probed on connect and on explicit refresh: a module with `Map<ProviderKind, ProviderStatus>`, a revision int and one in-flight promise per provider is ~85 lines. |
| `shutdownDeadline.ts` | 97 | Clean, but main's close path already has `DeferredClose`/`SessionCloseMode` (`SessionLifecycle.ts:47-57`). A second shutdown vocabulary is net complexity. |
| `droidCapabilityGate.ts`, `droidSessionAccess.ts`, `DroidProviderSession.ts` | 1,016 | Written against the reference branch's storage-rewritten `LiveSession` and a `sessionPreActivationBuffer.ts` that does not exist on main. Our Droid adapter is ~85 lines because we keep `LiveSession.droid`. |
| `acp/**`, `cursor/**`, `grok/**` | ~5,900 | Out of scope, and not the cleanest transport factoring for what is in scope. Also avoids the `THIRD_PARTY_NOTICES.md` obligation entirely. |

Roughly 2,000 lines of reference-branch contract scaffolding replaced by ~260, losing neither property that mattered (stale-turn safety, typed capabilities).

### 3.3 Session seam: `LiveSession` gains one field and keeps one

```ts
export interface LiveSession extends LiveTurnState {
  summary: SessionSummary;
  session: ProviderSession;   // was FactorySession (SessionLifecycle.ts:70)
  droid?: FactorySession;     // present iff summary.provider === 'droid'
  …unchanged…
}
```

This is the decision that keeps the diff small and satisfies "Droid untouched at every PR":

- Generic call sites (`session.interrupt()`, `session.close()`, `session.stream()`) are unchanged text.
- The ~10 Droid-only session methods stay reachable through `liveSession.droid`, behind a capability guard. Exhaustive non-test call sites: `forkSession` `SessionManager.ts:755`; `getRewindInfo`/`executeRewind` `:783,:787`; `enterSpecMode` `:1586`; `renameSession` `:1681`; `listTools`/`listSkills` `:1725,:1735`; `compactSession` `compaction.ts:200`, `sessionCompactionExecution.ts:246`; `getContextStats` `SessionContext.ts:222`; `onNotification` `SessionCompaction.ts:229`; `initResult` `SessionLifecycle.ts:272`, `MissionControlPolicy.ts:76`, `ChildSessions.ts:869,934`, `childRuntimeOpen.ts:281`.
- `ChildRuntimeState.session` stays `FactorySession` (`ChildSessionsTypes.ts:23`), so **`ChildSessions.ts` (1263 lines) and `childRuntimeOpen.ts` (368) need zero changes** — they are simply never reached for non-Droid.
- `SessionContext.ts` (582) and `SessionCompaction.ts` (524) need zero changes: their targets are built by `primaryContextTarget`/`primaryAutomaticCompactionTarget` and typed `FactorySession`. We do not widen them; we **do not build a target** when the capability is false. `SessionContext.refresh` already swallows every error and `compaction.arm` already returns false without arming, so skipping is a clean no-op rather than a lie on the summary.

Context metering for non-Droid does not regress: `NormalizedEvent.tokens` (`normalize.ts:85`) already carries `{tokensIn, tokensOut, contextTokens}` into `recordUsage`, the same path Droid's `token_usage_update` takes (`normalize.ts:106-115`). Claude fills it from `result.modelUsage` and `stream_event.message_delta`; Codex from `thread/tokenUsage/updated` (`ThreadTokenUsage.modelContextWindow` supplies the limit). `contextAccuracy` reads `estimated` rather than faking `getContextStats`.

**Hot path.** Routing Droid through `DroidProviderSession.stream()` adds one generator frame per SDK event, and moves the `normalizeStreamEvent` call inside it so `applyNormalized` is reached directly — no wrapper object, no branch, same number of normalize calls. `npm run perf:replay -- --scenario streaming`, `npm run perf:compare` against `origin/main` and `npm run perf:gates` are merge gates on PR1, not afterthoughts. Pre-approved fallback on any measurable regression: keep a direct `liveSession.droid.stream()` + `eventFlow.applyStreamEvent` fast path in `runPrimaryTurn` when `liveSession.droid` is set, and route only non-Droid through the adapter. That is six lines; take it rather than argue.

### 3.4 Interactions: invert the port

`SessionInteractions.ts` (205 lines) is the only subsystem with Droid-SDK coupling **in its signature** — it imports seven symbols from `@factory/droid-sdk` at `SessionInteractions.ts:1-9` and resolves `RequestPermissionHandlerResult` / `AskUserResult`. Its internals are already neutral: `decidePermission` emits `{type:'approval.requested', request}` and parks a promise, `respondToApproval` resolves it, and outcomes already go through `permissionOutcomes.ts` (`isAlwaysOutcome`, `isApprovalOutcome`, `normalizePermissionOutcome`).

```ts
// sidecar/src/providers/interactions.ts  (~40 lines)
export interface ProviderInteractions {
  requestApproval(req: Omit<PermissionRequest, 'appSessionId'>): Promise<PermissionOutcome>;
  requestQuestion(req: Omit<SessionQuestion, 'appSessionId'>): Promise<{
    cancelled: boolean;
    answers: { index: number; question: string; answer: string }[];
  }>;
}
```

`PermissionRequest`, `SessionQuestion` and `PermissionKind` already exist (`protocol.ts:214-229`). `SessionInteractions` keeps every piece of real logic it has — unattended auto-approve policy (`automations/permissionPolicy.ts`), signature-based "always" grants, spec-exit, mission phase transitions — and loses its Droid imports. `classifyPermission`/`confirmationType`/`permissionSignature` consumption and the `RequestPermissionHandlerResult` mapping move to `providers/droid/droidInteractions.ts`. The reference branch's `providerInteractions.ts` (167 lines) assumed `PlanReviewRequest` and `PERMISSION_OUTCOMES`, neither of which exists on main; plan review is out of scope, so ~40 lines of that idea survive.

### 3.5 Identity and resume

| Provider | `appSessionId` | `providerSessionId` | resume handle |
|---|---|---|---|
| Droid | `session.sessionId` (unchanged, `SessionLifecycle.ts:187`) | same | `providerSessionId` |
| Claude | `crypto.randomUUID()` minted before `query()` | **same** — passed as `Options.sessionId` to pin the new session | `Options.resume: appSessionId` |
| Codex | minted up front | the `threadId` returned by `thread/start`, which we do not control | `resumeId` (`thread/resume {threadId}`) |

Claude pinning its own id is worth taking: one identifier, no late binding, and the transcript file name matches. Codex is the only provider needing a separate `resumeId`.

Keep Droid's `appSessionId === providerSessionId` collapse. Migrating thousands of existing Droid sessions to new ids is unjustifiable, and `SessionRegistry` already indexes both as aliases (`SessionRegistry.ts:372-403`) and resolves either (`:97`).

**Do not use `SessionRegistry.replaceProvider`** to late-bind a native id: it unconditionally pushes the old `providerSessionId` into `compactedFromProviderSessionIds` (`SessionRegistry.ts:200-204`), polluting the compaction chain. `resumeId` is not an `IdentityField` (`SessionRegistry.ts:14-20`), so a plain `updateSummary({ resumeId })` is correct.

### 3.6 Persistence: one extra scan root, no schema change

What main actually persists. `HistoryPersistence.recordEvent` enqueues `eventMetadata(event)`, which keeps only `{id, sourceSessionId, appSessionId, kind, ts}` (`historyPersistenceProtocol.ts:100-108`), and the `events` table has **no text column** (`history.ts:409-415`). It is a search/dedup index, not a transcript store. Scrollback comes from the provider's own JSONL:

- Enumeration: `loadHistoricalSessions` iterates `scanSessionFiles()` (`history.ts:196`), then `summarizeSessionFile` builds the whole restored summary from the file head line (`history.ts:1472-1514`) and `applyCachedSummary` patches it from `app_sessions`.
- Replay: `loadSessionPage` resolves the path from `sessionIndex()` and parses it (`history.ts:230-246`).
- Both bottom out in `scanSessionFileTree()`, whose root is hardcoded `join(homedir(), '.factory', 'sessions')` at `history.ts:1363`.

So a Claude or Codex session would today be invisible in the sidebar **and** empty after restart. That is the one place the no-rewrite constraint collides with the end state, and it needs no rewrite:

1. **`sidecar/src/providers/ProviderTranscriptFile.ts` (~130 lines)** — append-only JSONL writer emitting exactly the shapes `sessionTranscriptParser.ts` already parses: a `StoredSessionStart` head line (`sessionTranscriptParser.ts:36-49`) then one `StoredMessageLine` (`:28-35`) per settled message, into `<droidexUserDataDir()>/provider-sessions/<appSessionId>.jsonl`. Wired at the `SessionTimeline.recordAndEmit` boundary for non-Droid sessions only, behind an injected writer, so streaming coalescing (`streamingDeltaCoalescer.ts`) is respected, one file line equals one settled message, and Droid pays nothing.
2. **`history.ts:1363`** — `scanSessionFileTree()` walks two roots instead of one.

That second bullet is the whole reader change. Enumeration, replay, the file-cache reconcile (`history.ts:496`), the LRU, the cursor contract, the search index and markdown export all work unchanged, because they are all downstream of that one scan and our file is named by `appSessionId`.

**And no DB migration.** `summarizeSessionFile` hardcodes `provider: DEFAULT_PROVIDER` at `history.ts:1492` because the head line has nowhere to carry it. Add two optional fields to `StoredSessionStart` — `provider?: string`, `resumeId?: string` — read them at `history.ts:1492` through `providerKind(start.provider) ?? DEFAULT_PROVIDER`, and the binding plus the Codex resume handle persist with **zero** schema work: no `HISTORY_SCHEMA_VERSION` bump, no `ALTER TABLE`, no `CANONICAL_TABLE_COLUMNS` churn, no `historyWriteStatements.ts` edit, and no exposure to `history.ts:156-166`'s user-hostile "quit and delete these three files" recovery path. Droid files have no `provider` field and read as Droid, so every existing session stays valid with no data migration. `sessionAdoption.ts:203` keeps `DEFAULT_PROVIDER` (adoption is a Droid-CLI path by definition).

One implementation note for PR4: `summarizeSessionFile` also calls `readSessionModelSettings(start, file.path)` and `classifyStoredSession(start)`, and `launchSettings` requires `settings.modelId` for resume (`history.ts:1516-1517`). The writer must populate whatever those read, or non-Droid sessions will be classified out at `history.ts:1485`. Confirm both functions' inputs before writing the head line.

### 3.7 Event mapping — Claude (`@anthropic-ai/claude-agent-sdk` 0.3.270)

Target is `NormalizedEvent`; `TranscriptEvent.kind` is one of `'text'|'thinking'|'tool_call'|'tool_result'|'error'|'status'|'compaction'` (`protocol.ts:179`).

| SDK message | → `NormalizedEvent` |
|---|---|
| `system`/`init` | nothing on the transcript; record `session_id`, tools, model, capabilities. Detect a session-id change on **any** message carrying a durable id, not only init. |
| `stream_event` · `content_block_delta` · `text_delta` | `{transcript: {kind:'text', text: delta}}` — **the authoritative text source** |
| `stream_event` · `content_block_delta` · `thinking_delta` | `{transcript: {kind:'thinking', text: delta}}` |
| `stream_event` · `content_block_start` (`tool_use`/`server_tool_use`/`mcp_tool_use`) | `{transcript: {kind:'tool_call', toolName, toolUseId}}` |
| `stream_event` · `content_block_delta` · `input_json_delta` | tool-args update on the open `tool_call`, progressively re-parsed |
| `stream_event` · `message_delta` | `{tokens: …}` live usage snapshot |
| `assistant` (snapshot) | **completion signal only**, plus a fallback for blocks that streamed no deltas. Never re-emit `message.content` text. |
| `user` (tool_result) | `{transcript: {kind:'tool_result', toolUseId, isError?}}` |
| `result` (`success`/`error_*`) | `{done: true}` + `{tokens: …}` from `modelUsage` (**not** `usage`, which excludes subagents) |
| `rate_limit_event` | `{transcript: {kind:'status', text: …}}`; a rejected window with no overage otherwise looks like a silent hang |

Three rules that are bugs if missed:
- **Delta-authoritative, snapshot-fallback.** Deltas are the only source of incremental text; the snapshot walks content blocks positionally and only fills a block that produced no deltas. Re-emitting snapshot content with `includePartialMessages: true` double-renders every message.
- **`parent_tool_use_id` non-null = subagent frame.** Drop its text/thinking deltas (subagent narration must not leak into the main transcript) but keep its `tool_use` starts and `input_json_delta`s, or subagent tool inputs arrive empty.
- **A `result` with no active local turn** is a resume handshake or a late duplicate: log it and record usage; never flip session phase.

Add a compile-time exhaustiveness guard (`message satisfies never` in the `default` branch) so an SDK upgrade that adds a top-level message type fails typecheck instead of silently dropping it. `SDKMessage` is a 40-member union in 0.3.270; we handle the five core members plus `rate_limit_event`.

### 3.8 Event mapping — Codex (`codex app-server`, local CLI 0.149.0)

Transport: newline-delimited JSON, **not** JSON-RPC 2.0 (no `jsonrpc` field), CRLF-tolerant, monotonic numeric client ids from 1, pending-request registration **before** the serialized write, a 1 MiB max-line guard, fail-all-pending on exit, and a final unterminated-line flush at EOF. Our dispatch loop drains synchronously into the event flow — **do not** copy T3's 32-item `Queue.sliding`, which silently drops older streaming deltas under backpressure.

Spawn `<binary> app-server` over stdio with `CODEX_HOME` **`~`-expanded before spawn** (`child_process.spawn` does not shell-expand env values; Codex errors out otherwise). Register every server-request and notification handler **before** sending `initialize`, then a bare `initialized` notification with no params. `initialize` params: `{clientInfo:{name:'droidex',title:'DROIDEX',version}, capabilities:{experimentalApi:true}}`. Extract the running version from `InitializeResponse.userAgent`.

Notifications consumed — the T3-verified minimal subset, everything else explicitly ignored:

| Notification | → `NormalizedEvent` |
|---|---|
| `thread/started` | capture `threadId` → `resumeId` |
| `turn/started` | capture `turnId` (needed for steer and interrupt) |
| `item/agentMessage/delta` | `{transcript:{kind:'text', text: delta}}` |
| `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` | `{transcript:{kind:'thinking', text: delta}}` |
| `item/started` (`commandExecution`/`fileChange`/`mcpToolCall`) | `{transcript:{kind:'tool_call', toolName, toolUseId: itemId}}` |
| `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated` | append to the open `tool_result` |
| `item/completed` | `{transcript:{kind:'tool_result', toolUseId: itemId, isError?}}` |
| `thread/tokenUsage/updated` | `{tokens: …}` incl. `modelContextWindow` |
| `turn/completed` | `{done: true}` |
| `error` | `{transcript:{kind:'error', text: error.message}}`; `willRetry` decides whether the turn fails |

Autonomy mapping. `thread/start` takes the coarse `SandboxMode` enum; `turn/start` takes the richer `SandboxPolicy` union — build the right shape per call site.

| Autonomy | `approvalPolicy` | sandbox |
|---|---|---|
| off | `untrusted` | read-only |
| low / medium | `on-request` | workspace-write |
| high | `never` | danger-full-access |

`thread/resume {threadId}` **never falls back to `thread/start`**; a missing thread is a visible resume failure. T3's own code does fall back (`CodexSessionRuntime.ts:744-768`); that is a bug pattern, not a model.

### 3.9 Permission and question mapping

| | Claude | Codex |
|---|---|---|
| approval in | `Options.canUseTool(toolName, input, opts)` | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` |
| `proceed_once` | `{behavior:'allow'}` | `accept` |
| `proceed_always` | `{behavior:'allow', updatedPermissions: opts.suggestions}` | `acceptForSession` |
| deny | `{behavior:'deny', message}` | `decline` |
| cancel | `{behavior:'deny', interrupt:true}` | `cancel` |
| question | `AskUserQuestion` tool → `requestQuestion` | `item/tool/requestUserInput` → `{answers:{[id]:{answers:[…]}}}`; cancel = empty map |
| plan | `ExitPlanMode` → capture plan text, **always** `{behavior:'deny', message:'…wait for feedback'}` | n/a |
| interrupt | `Query.interrupt()` on the live process | `turn/interrupt {threadId, turnId}` with a stale-pair guard |

`decline` ≠ `cancel`: decline lets the turn continue, cancel interrupts it. Mapping deny to `cancel` aborts turns unnecessarily.

**Fail closed.** Codex's legacy `execCommandApproval`/`applyPatchApproval` and the newer `item/permissions/requestApproval` and `mcpServer/elicitation/request` get a method-not-found error response. Never auto-grant. Claude's `canUseTool` must never return `null`/`undefined` on an unhandled path — that parks the request forever with no deadline.

Claude permission mode is derived once, at a single authoritative merge point, so argv overrides cannot fight the mapped value: off→`dontAsk`, low/medium→`default`, high→`bypassPermissions` (plus `allowDangerouslySkipPermissions`), plan mode→`plan`. `PermissionMode` is a **6**-way union in 0.3.270 (`'dontAsk'` and `'auto'` added); the mapping function returns the union type, not a 4-case literal. Reconcile the live `permission_denials` stream against the authoritative `result.permission_denials`.

### 3.10 Process handling

- Claude: always streaming-input mode (a live `AsyncIterable<SDKUserMessage>` prompt) — required for `setPermissionMode`/`setModel` and for steering without a restart. `settingSources` must include `'project'` or CLAUDE.md is not loaded. Probe with an async generator that never yields, then `initializationResult()`, aborting in `finally` — zero API cost. `close()` is graceful-then-forced (SDK escalates SIGTERM→SIGKILL); do not wrap it in our own kill timer. **Never set `env.HOME`** — on macOS it relocates the login keychain and the CLI reports "Not logged in"; use `CLAUDE_CONFIG_DIR` if isolation is ever needed. Windows needs `.cmd`/`.bat`/`.ps1` shim following because the SDK spawns without a shell or PATHEXT resolution.
- Codex: one `codex app-server` child per session, tracked the way `trackProviderProcess` (`SessionLifecycle.ts:208`) already tracks Droid's.
- `interrupt()` uses each provider's real live-turn abort, not kill-and-resume. We advertise `capabilities.interrupt`, so Stop must not cost a process respawn. T3 collapses interrupt into stop for Claude; we decline that shortcut, with kill+resume as the documented fallback if the live interrupt proves unreliable.

### 3.11 File layout

```
sidecar/src/providers/
  providerKind.ts              EXISTS on main — extended, not replaced
  session.ts                   Provider, ProviderSession, ProviderCapabilities, ProviderStatus   ~95
  capabilities.ts              DROID_/CLAUDE_/CODEX_CAPABILITIES tables                          ~45
  interactions.ts              ProviderInteractions port                                         ~40
  registry.ts                  Map + revision + one in-flight probe per provider                 ~85
  primaryTurn.ts               runPrimaryTurn, extracted from SessionManager                    ~120
  ProviderTranscriptFile.ts    append-only StoredMessageLine writer                             ~130
  droid/DroidProvider.ts       Provider over the existing DroidRuntime                           ~70
  droid/DroidProviderSession.ts FactorySession -> ProviderSession                                ~85
  droid/droidInteractions.ts   PermissionOutcome <-> droid SDK result                            ~60
  claude/ClaudeProvider.ts     probe, create, resume, model manifest                            ~170
  claude/claudeSession.ts      query() lifecycle, prompt queue, canUseTool, interrupt           ~240
  claude/claudeEvents.ts       SDKMessage -> NormalizedEvent                                    ~250
  claude/claudeExecutable.ts   path resolution, CLAUDE_CONFIG_DIR                                ~60
  codex/appServer.ts           NDJSON JSON-RPC client                                           ~200
  codex/CodexProvider.ts       spawn, initialize, model/list, account/read, version gate        ~180
  codex/codexSession.ts        thread/turn lifecycle, approvals, questions                      ~240
  codex/codexEvents.ts         notifications -> NormalizedEvent                                 ~230
src/features/providers/
  providerIdentity.ts          PROVIDER_ORDER, display names, type guard                          ~30
  ProviderPicker.tsx           composer control in main's chip idiom                              ~70
  providerDraft.ts             localStorage last pick + per-provider model                        ~70
  providerCapabilities.ts      renderer-side gating predicates + Droid fallback table             ~60
```

Every file under 500 lines; every file under 250. `SessionManager.ts` (2016) must come out **smaller** after PR1 via the `primaryTurn.ts` extraction; if it grows, the PR is wrong.

### 3.12 Wire additions (the entire new bridge surface)

`SessionSummary.provider` and `session.create.provider` already exist. Three additions:

```ts
SessionSummary.resumeId?: string
ClientCommand | { type: 'provider.refresh' }
ServerEvent  | { type: 'provider.status'; statuses: ProviderStatus[] }
```

All additive, all optional, no existing message changes shape. Mirror by hand into `src/types/bridge.ts` (its header mandates this) and extend `src/lib/bridgeWireValidation.ts`.

### 3.13 Renderer

`src/components/ModelIcon.tsx:12-21`'s `providerOf()` already returns `'anthropic'` for `/anthropic|claude/` and `'openai'` for `/openai|gpt|codex/`, and `ModelIcon` already renders both marks. **No new icon assets.** Transcript rendering, `PermissionInline.tsx`, `AskUserInline.tsx`, streaming and sidebar rows already consume generic `TranscriptEvent`/`SessionSummary`. Session creation is one call (`src/lib/commands.ts:34-55`) from two sites (`PromptInput.tsx:1019,:1068`), and `commands.ts:41` already carries `provider?`.

The picker goes next to the existing model chip as an icon chip, locked once the session exists. The reference branch's `HarnessStrip.tsx` — a 5-column grid of labelled pills in a bordered tray — is **not** ported as written: main's composer uses icon chips, and per the design-language rule we move the placement into main's idiom rather than pasting a foreign control block into the composer. Droid rows stay unmarked in the sidebar (it is the default; marking every existing row is visual change nobody asked for). `providerDraft.ts` keeps the reference branch's defensive localStorage parse pattern, which is correct. `composerHarness.ts`/`providerCatalog.ts`/`providerCapabilities.ts` are not ported verbatim — they are shaped around the 5-provider `ProviderWireSnapshot`.

`src/hooks/useStore.tsx` (2561 lines, centrally contended) is **hand-merged only**, written fresh against current main: `providerStatuses` in state, a `provider.status` reducer case, `draftProvider` beside `draftAutonomy`, reset on the same lifecycle transitions.

### 3.14 Untouched by this stack

Zero lines in: `normalize.ts`, `SessionContext.ts`, `SessionCompaction.ts`, `ChildSessions.ts`, `childRuntimeOpen.ts`, `sessionCompactionExecution.ts`, `compaction.ts`, `McpSettings.ts`, `MissionControlPolicy.ts`, `SessionRegistry.ts`, `HistoryPersistence*`, `historyWriteStatements.ts`, `bridgeServer.ts`, `streamingDeltaCoalescer.ts`, `sessionTranscript.ts`, and every renderer transcript/approval/question component.

---

## 4. PR stack

Eight PRs on `providers/integration`. Droid is the default and the only selectable provider until PR3. Standing verification on every PR: `npm run typecheck && npm run sidecar:typecheck && npx eslint <touched files> && npm run sidecar:test && npm test && npm run quality:file-size && npm run quality:boundaries`, plus `npm run quality:deadcode` for renderer PRs (`knip.json` has `"ignore": ["sidecar/**"]`, so sidecar dead code is caught by `typecheck:strict` and explicit deletion instead). Deleting what the change orphans is part of every PR's definition of done.

Rule for PR1 and PR2: **if an existing test needs editing, the refactor changed behaviour — stop and fix the refactor.** That is a stronger gate than any new test.

### PR1 — `ProviderSession` seam, Droid wrapped in place
Goal: `LiveSession.session` is a `ProviderSession` yielding `NormalizedEvent`; Droid is the only registered provider; the app is byte-for-byte as before. Full brief in §6.
Created: `providers/session.ts` (~95), `providers/capabilities.ts` (~45), `providers/droid/DroidProvider.ts` (~70), `providers/droid/DroidProviderSession.ts` (~85), `providers/primaryTurn.ts` (~120, moved out of `SessionManager.ts:1248-1294`).
Edited: `SessionEventFlow.ts` (+~8, `applyNormalized` → public `apply`), `SessionLifecycle.ts` (~70 changed), `SessionManager.ts` (~50 changed, net smaller).
Ported: nothing. Risk: **high** — hottest path in the app, but the diff is a type swap with no logic change.
Verify: ~6,000 lines of existing sidecar session suites green **with zero test edits** (`SessionLifecycle.test.ts` 1377, `SessionManager.sessionLifecycle.test.ts` 871, `SessionManager.eventFlow.test.ts` 733, `SessionEventFlow.test.ts` 378, `inFlightRaces`, `teardown`, `shutdownOrder`); then `perf:replay --scenario streaming` + `perf:compare` vs `origin/main` + `perf:gates`; then the real app against the real droid CLI: create, stream, approve, Stop, steer, compact, fork, rewind, spawn a subagent, quit, resume.

### PR2 — Neutral interactions port
Goal: `SessionInteractions` stops importing `@factory/droid-sdk`.
Created: `providers/interactions.ts` (~40), `providers/droid/droidInteractions.ts` (~60).
Edited: `SessionInteractions.ts` (205 → ~190), `SessionLifecycle.ts` (the two handler deps collapse to one `interactionsFor(ref)`), `providers/droid/DroidProvider.ts` (builds the droid `PermissionHandler`/`AskUserHandler` from the injected port).
Risk: **low-medium** (approval correctness is user-visible).
Verify: `SessionInteractions.test.ts` and `SessionManager.interactions.test.ts` green unedited; in-app trigger an edit approval — approve once, approve-always (a second identical request must auto-grant), deny, an `AskUserQuestion`, and a spec-mode exit still flipping to Auto.

### PR3 — Provider status on the wire + composer picker
Goal: the user sees and picks a provider; only Droid is selectable; nothing else changes.
Created: `providers/registry.ts` (~85); renderer `features/providers/{providerIdentity.ts, ProviderPicker.tsx, providerDraft.ts, providerCapabilities.ts}` (~230 total).
Edited: `protocol.ts` (+~20: `provider.status`, `provider.refresh`, `SessionSummary.resumeId`), `src/types/bridge.ts` (+~20 mirror), `src/lib/bridgeWireValidation.ts` (+~15), `SessionManager.ts` (+~25: emit status after connect and on refresh; route `command.provider` to the registry), `useStore.tsx` (+~35 hand-merge), `src/lib/commands.ts` (+~5 `refreshProviders()`), `PromptInput.tsx` (+~25), `SidebarSessionRow.tsx` (+~10).
Ported: `providerIdentity.ts` and the `providerDraft.ts` localStorage pattern in spirit (27 + 115 reference lines → ~100). Not ported: `ProviderWireSnapshot`/`ProviderCapabilitySnapshot` (replaced by `ProviderStatus`), `publishProviderSnapshots.ts` (91 → ~12 inside the registry), `unavailableProvider.ts` (123 → a `readiness:'missing'` literal).
Risk: **low** sidecar, **medium** for the `useStore.tsx` hand-merge.
Verify: picker shows Droid enabled, Claude/Codex disabled with "not installed"; pick Droid and everything behaves as today; restart and the pick persists; the ~20 existing `useStore*.test.ts` files green.

### PR4 — Non-Droid transcript durability
Goal: a provider with no `~/.factory/sessions/*.jsonl` is both listed and scrollable after restart. No schema change.
Created: `providers/ProviderTranscriptFile.ts` (~130).
Edited: `sessionTranscriptParser.ts` (+2 optional fields on `StoredSessionStart`), `history.ts` (~30: second root in `scanSessionFileTree` at `:1363`; read `provider`/`resumeId` at `:1492`), `SessionTimeline.ts` (~20, injected writer on `recordAndEmit`, non-Droid only), `droidexPaths.ts` (+4, `providerSessionsDir()`).
Risk: **medium**, and it is the one PR that cannot be end-to-end verified until PR5.
Verify: hand-write a two-message fixture `.jsonl` into the new root and confirm the session lists, opens, and pages in the app; `sessionTranscript.test.ts`, `sessionTranscriptParser.test.ts`, `historyFileCache.test.ts`, `sessionFileWatcher.test.ts`, `historySearchIndex.test.ts`, `historyIndexDatabase.test.ts`, `upgradeFromMain.test.ts` green. If landing unprovable-until-PR5 is unacceptable, fold this into PR5 and accept one ~500-line PR.

### PR5 — Claude provider: first working non-Droid session
Created: `providers/claude/{ClaudeProvider.ts ~170, claudeSession.ts ~240, claudeEvents.ts ~250, claudeExecutable.ts ~60}`.
Edited: `providers/registry.ts` (+5), `SessionLifecycle.ts` (~40: select the provider in `create`/`resume`; capability-gate `compaction.arm`, `compaction.subscribePrimary`, `childSessions.attachParent`, `context.startPolling`/`refresh`), `SessionManager.ts` (~20: Droid-only commands early-return a clear "not supported for this provider" error; `primaryContextTarget`/`primaryAutomaticCompactionTarget` built only when `liveSession.droid` is set; `applyDesignToolPolicy` no-ops without it), `ModelSelectorPopover.tsx` (~+30, model list from `providerStatuses` for non-Droid), renderer capability gating (hide spec toggle and mission affordances when the capability is false), `sidecar/package.json` (+`@anthropic-ai/claude-agent-sdk` ^0.3.270).
Ported: nothing — **the reference branch has no Claude adapter**, only design docs, whose `interrupt` description and 4-value `PermissionMode` table are both stale.
Risk: **high** (new dependency, new streaming mapper).
Verify: real `claude` CLI (2.1.267 local). Streaming text renders **once** (no duplication), reasoning renders as thinking rows, `Read`/`Bash` render as tool_call/tool_result pairs, the context meter moves from `result.modelUsage`, Stop aborts the turn **without** killing the session, a queued second prompt works, then quit, relaunch, reopen — full scrollback (PR4's proof) and a follow-up prompt resumes the same Claude session. Then pick Droid in the same app run and confirm an unchanged Droid turn.

### PR6 — Claude interactions: approvals, questions, plan mode, rate limits
Edited: `claudeSession.ts` (+~90, the `canUseTool` closure and the single permission-mode merge point), `claudeEvents.ts` (+~50, `rate_limit_event`, denial reconciliation, result-with-no-active-turn).
Risk: medium.
Verify: at autonomy `low` an edit raises an approval card and approve/deny both round-trip; a clarifying question round-trips; plan mode surfaces the plan and executes no tools; `setModel` mid-session; a denied tool reads as denied in the transcript.

### PR7 — Codex app-server transport and turns
Created: `providers/codex/{appServer.ts ~200, CodexProvider.ts ~180, codexSession.ts ~180, codexEvents.ts ~230}`.
Edited: `providers/registry.ts` (+5).
Ported: nothing (no Codex adapter exists on the reference branch). Re-run `codex app-server generate-ts --experimental` and diff against the assumed shapes **before** writing this PR.
Depends on PR4 only; independent of PR5/PR6 in principle, stacked after for linear review.
Risk: **high** (upstream-experimental protocol).
Verify: real `codex` CLI (0.149.0 local). A prompt that reads a file and runs a command streams text, reasoning and command output; the token meter moves; killing the `codex` process externally produces a clean error row, not a hang.

### PR8 — Codex interactions, resume, version gate
Edited: `codexSession.ts` (+~120), `CodexProvider.ts` (+~30).
Substance: both current approval methods → the interactions port; `item/tool/requestUserInput` → questions; `serverRequest/resolved` clears an approval resolved elsewhere; legacy and permissions/elicitation requests fail closed; `turn/steer` with `expectedTurnId`; `turn/interrupt` with a stale-pair guard; `thread/resume` with no `thread/start` fallback; readiness `unsupported` with a clear message outside the reviewed `userAgent` range.
Risk: medium.
Verify: approve/deny/cancel each behave distinctly (deny lets the agent continue, cancel ends the turn); a mid-turn question round-trips; Stop interrupts; `sendNow` steers; point at an old `codex` binary and get a clean "unsupported version" instead of a crash; quit and relaunch, both a Claude and a Codex session reappear with their icon, open with scrollback, and continue the same conversation (confirm by asking the agent what you said first).

**Ordering.** PR1 → PR2 → PR3 → PR4 serial. PR5→PR6 and PR7→PR8 are two chains that can be developed in parallel once PR4 lands. Earliest working Claude session: end of PR5, five PRs in, of which PR2 and PR4 are small.

---

## 5. Provenance and attribution

No source is copied from T3 Code or the reference branch's T3-derived files. Because `acp/`, `cursor/` and `grok/` are out of scope, the reference branch's `THIRD_PARTY_NOTICES.md` + `third_party/t3-code/LICENSE` obligation does not travel with this stack.

Codex's framing, the autonomy→sandbox table and the notification subset are **informed by** reading T3 Code (MIT) and by the local CLI's own `generate-json-schema`/`generate-ts` output. Attribution is a `@derived-from` comment at the top of `providers/codex/appServer.ts` and `providers/codex/codexSession.ts` naming T3 Code and the pinned upstream Codex commit `678157acaa819d5510adfe359abb5d0392cfe461`, with the framing written from the JSON schema rather than transcribed.

**If any line of `appServer.ts` is lifted verbatim from T3's `packages/effect-codex-app-server/src/protocol.ts`, the notices file and license obligation return.** Write it from the schema.

---

## 6. Risks and open questions

1. **PR1 touches the hottest path.** `runPrimaryTurn`, `SessionEventFlow`, `SessionLifecycle` move in one PR. Mitigation: zero test edits as the gate, plus `perf:replay`/`perf:compare`/`perf:gates` against `origin/main` before merge — measured, not assumed — with the pre-approved direct-`droid.stream()` fast path as the fallback on any measurable regression.
2. **Codex rides an upstream-experimental API.** The whole `thread/*`/`turn/*`/`item/*` surface sits behind `capabilities.experimentalApi: true`; OpenAI can rename methods without deprecation. PR8's version gate turns that into an honest `unsupported` readiness rather than a mystery hang, but Codex will need periodic protocol maintenance. Inherited fragility, accepted knowingly.
3. **Claude text duplication** is the single thing to review hardest in PR5. Delta-authoritative plus positional snapshot backfill is the fix.
4. **`useStore.tsx` hand-merge** (2561 lines, centrally churning). Never take the reference branch's version of anything in it.
5. **No automated coverage for PRs 5-8.** Per the constraint there are no new test files, and no existing suite covers a new adapter. Verification is the real CLI in the real app. Flagging the gap so it is owned, not discovered.
6. **`SessionManager.ts` is already 2016 lines.** PR1 must leave it smaller.
7. **Claude `interrupt()` semantics are unverified in our shape.** We call `Query.interrupt()`; T3 kills the query and resumes next turn. If the live interrupt wedges the session, the fallback costs a respawn per Stop and must then be visible in the UI.

**Open questions for the user.**
(a) Non-Droid sessions: hide unsupported controls (spec, mission, rewind, fork, compact) or show them disabled with a tooltip? Hidden is cleaner; disabled teaches. Design call.
(b) Picker placement: icon chip beside the model chip (my default, main's idiom) vs the reference branch's labelled strip. The user's call, not an engineering one.
(c) Do Claude and Codex models join the single existing model catalog (so `ModelSelectorPopover`, `ModelCatalogList` and `providerOf()` need no change) or get per-provider lists? I chose the single catalog, but `categoryOf()` (`ModelSelectorPopover.tsx:30-35`) has Droid-flavoured category labels that will want another bucket.
(d) `ReasoningEffort` is 9-wide on main (`protocol.ts:35-43`); Claude has `effort` + `maxThinkingTokens`, Codex its own enum plus `summary`. Plan: a lossy per-provider table with unsupported values simply absent from the model's `supportedReasoningEfforts` so the existing UI hides them. Acceptable, or do you want a per-provider effort vocabulary?
(e) Claude steering: ship PR5 with `steer: false` (queue the prompt) and spend a later PR on true mid-turn steering, or do it in PR6?
(f) Codex version policy: hard-fail outside the reviewed CLI range (PR8's current behaviour, safer) or warn and proceed?

# Provider Core and Droid Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox syntax for tracking.

**Goal:** Introduce the smallest provider-neutral runtime seam and route all
existing Droid sessions through it without changing visible Droid behavior.

**Architecture:** `ProviderRegistry` owns three static adapter definitions and
sanitized per-instance snapshots, but never owns sessions. `SessionRegistry`
continues to own live app sessions. A `ProviderAdapter` opens one
`ProviderSession`; the session buffers early native events until
`SessionLifecycle` durably binds and activates it. Adapters normalize native
events and interaction callbacks before shared lifecycle code sees them.

**Tech Stack:** TypeScript, Node.js 22.23.1, Factory Droid SDK, Zod,
`node:test`.

## Global Constraints

- Foundation plan and its canonical-store checkpoint must be complete first.
- Follow
  `docs/superpowers/specs/2026-08-12-multi-provider-runtime-design.md`.
- Do not add a ProviderService, adapter-registry facade, session directory,
  provider event bus, Effect, or a second lifecycle owner.
- Static v1 instance IDs are exactly `droid`, `codex`, and `claude`; Droid is
  first and default.
- Capabilities are truthful and enforced sidecar-side before provider mutation.
- `SessionLifecycle` captures app identity, provider instance, runtime
  generation, and turn identity before every provider await and revalidates
  them afterward.
- No Factory SDK type may remain in common provider contracts,
  `SessionLifecycle`, `SessionInteractions`, or `SessionEventFlow` after the
  checkpoint.
- Existing Droid compaction, context, children, Mission Control, browser, MCP,
  approvals, questions, rewind, fork, skills, and slash behavior remains green.
- Every new production file stays below 500 lines; do not materially grow
  existing oversized files.
- All work stays local and every task is a focused buildable commit.

---

### Task 1: Characterize the Droid provider-facing boundary

**Files:**

- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionManager.interactions.test.ts`
- Modify: `sidecar/src/SessionManager.eventFlow.test.ts`
- Modify: `sidecar/src/SessionManager.inFlightRaces.test.ts`

This commit characterizes only the current Factory-backed production entry
points. It imports no provider contract that does not exist yet and creates no
fake provider, harness, or production seam. Preserve the current test support
and name each assertion by the user-visible Droid invariant it freezes.

- [ ] **Step 1: Add failing characterization scenarios**

Name current-Factory scenarios for create/resume/send/interrupt/close ordering,
duplicate `clientRef`, early notification buffering, record-before-emit,
callback settlement, and one-session failure isolation. Do not assert the new
provider contract, new native-ID separation, or registry behavior in this
commit.

- [ ] **Step 2: Run and confirm the seam is absent**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionManager.interactions.test.ts sidecar/src/SessionManager.eventFlow.test.ts sidecar/src/SessionManager.inFlightRaces.test.ts
```

- [ ] **Step 3: Complete only current-Factory characterization**

Do not add provider contracts, production adapter abstractions, a fake adapter,
or a test harness in this characterization commit.

- [ ] **Step 4: Commit**

```bash
rtk git add sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionManager.interactions.test.ts sidecar/src/SessionManager.eventFlow.test.ts sidecar/src/SessionManager.inFlightRaces.test.ts
rtk git commit -m "test(providers): characterize the Droid runtime boundary"
```

### Task 2: Add compact provider contracts and canonical events

**Files:**

- Create: `sidecar/src/providers/providerTypes.ts`
- Create: `sidecar/src/providers/providerTypes.test.ts`
- Create: `sidecar/src/providers/providerEvents.ts`
- Create: `sidecar/src/providers/providerEvents.test.ts`
- Create: `sidecar/src/providers/testing/ProviderContractHarness.ts`
- Create: `sidecar/src/providers/testing/FakeProviderAdapter.ts`
- Create: `sidecar/src/providers/testing/FakeProviderAdapter.test.ts`

**Core contracts:**

```ts
export interface ProviderDefinition {
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  displayName: string;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: readonly ReasoningEffort[];
  serviceTiers: readonly string[];
}

export interface ProviderCapabilities {
  modes: readonly SessionInteractionMode[];
  autonomyLevels: readonly Autonomy[];
  modelChange: 'before_turn' | 'idle_only' | 'unsupported';
  resume: boolean;
  steer: boolean;
  interrupt: boolean;
  approvals: boolean;
  questions: boolean;
  planReview: boolean;
  context: boolean;
  compaction: boolean;
  skills: boolean;
  slashCommands: boolean;
  mcpUse: boolean;
  mcpManagement: boolean;
  rewind: boolean;
  fork: boolean;
  observationalTasks: boolean;
  addressableChildren: boolean;
  missionControl: boolean;
  browser: boolean;
}

export interface ProviderPrompt {
  text: string;
  skills: readonly string[];
  files: readonly string[];
  browserRefs: readonly BrowserTranscriptReference[];
}

export interface ProviderApprovalRequest {
  requestId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  kind: PermissionKind;
  title: string;
  detail: string;
  plan?: string;
  options?: readonly string[];
}

export type ProviderApprovalDecision =
  | { decision: 'allow_once' | 'allow_session' | 'deny' | 'cancel' }
  | { decision: 'option'; option: string };

export interface ProviderQuestionRequest {
  requestId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  questions: readonly {
    id: string;
    prompt: string;
    options: readonly string[];
    multiSelect: boolean;
  }[];
}

export type ProviderQuestionAnswer =
  | { status: 'answered'; answers: Readonly<Record<string, readonly string[]>> }
  | { status: 'cancelled' };

export interface ProviderPlanReviewRequest {
  requestId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  plan: string;
}

export type ProviderPlanReviewDecision =
  | { decision: 'implement' }
  | { decision: 'iterate'; feedback: string }
  | { decision: 'cancel' };

export interface ProviderIdSource {
  nextEventId(): string;
  nextProviderSessionId(): string;
}

export interface ProviderClock {
  now(): number;
}

export interface ProviderInteractionSink {
  requestApproval(input: ProviderApprovalRequest): Promise<ProviderApprovalDecision>;
  requestQuestion(input: ProviderQuestionRequest): Promise<ProviderQuestionAnswer>;
  requestPlanReview(input: ProviderPlanReviewRequest): Promise<ProviderPlanReviewDecision>;
}

export interface ProviderRuntimeEventBase {
  eventId: string;
  target: SessionTarget;
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  runtimeGeneration: number;
  createdAt: number;
  turnId?: string;
  nativeCorrelation?: {
    sessionId?: string;
    turnId?: string;
    itemId?: string;
  };
}

export type ProviderSessionEffect =
  | { kind: 'context'; stats: ContextStatsSnapshot }
  | { kind: 'resume_state'; resumeState: unknown }
  | {
      kind: 'compaction';
      compactType: 'auto' | 'manual';
      removedCount: number;
    }
  | {
      kind: 'observational_task';
      taskId: string;
      label: string;
      status: 'running' | 'completed' | 'failed';
      preview?: string;
    }
  | { kind: 'child_upsert'; child: ChildSessionSummary };

export type ProviderRuntimeEvent = ProviderRuntimeEventBase &
  (
    | {
        type: 'transcript';
        event: Omit<
          TranscriptEvent,
          'id' | 'appSessionId' | 'sourceSessionId' | 'seq' | 'ts'
        >;
      }
    | {
        type: 'usage';
        inputTokens: number;
        outputTokens: number;
        contextTokens?: number;
      }
    | { type: 'session.effect'; effect: ProviderSessionEffect }
    | {
        type: 'binding.updated';
        binding: { providerSessionId?: string; resumeState: unknown };
      }
    | { type: 'turn.settled'; settlement: ProviderTurnSettlement }
    | { type: 'warning'; message: string }
    | { type: 'error'; error: ProviderError }
  );

export type ProviderEventSink = (event: ProviderRuntimeEvent) => void;

export interface ProviderSnapshot {
  definition: ProviderDefinition;
  revision: number;
  readiness:
    | 'ready'
    | 'missing'
    | 'unauthenticated'
    | 'unsupported'
    | 'unavailable'
    | 'error';
  executable?: { name: string; version: string };
  auth?: { accountLabel?: string; apiProviderLabel?: string; billingLabel?: string };
  models: readonly ProviderModel[];
  capabilities: ProviderCapabilities;
  error?: ProviderError;
}

export interface ProviderSessionCreateInput {
  target: SessionTarget;
  configuration: SessionConfiguration;
  expectedGeneration: number;
  cwd: string;
  eventSink: ProviderEventSink;
  interactionSink: ProviderInteractionSink;
  ids: ProviderIdSource;
  clock: ProviderClock;
}

export interface ProviderSessionResumeInput extends ProviderSessionCreateInput {
  resumeState: unknown;
}

export interface ProviderTurnInput {
  turnId: string;
  prompt: ProviderPrompt;
  configuration: SessionConfiguration;
}

export type ProviderTurnSettlement =
  | { status: 'completed' }
  | { status: 'failed'; error: ProviderError }
  | { status: 'interrupted' | 'cancelled' };

export interface ProviderSteerInput {
  turnId: string;
  prompt: ProviderPrompt;
}

export interface ProviderAdapter {
  readonly definition: ProviderDefinition;
  probe(signal: AbortSignal): Promise<ProviderSnapshot>;
  create(input: ProviderSessionCreateInput): Promise<ProviderSession>;
  resume(input: ProviderSessionResumeInput): Promise<ProviderSession>;
  close(deadline: ShutdownDeadline): Promise<void>;
}

export interface ProviderSession {
  readonly providerSessionId: string;
  readonly initialResumeState: unknown;
  activate(): void;
  startTurn(input: ProviderTurnInput): Promise<void>;
  steer(input: ProviderSteerInput): Promise<void>;
  interrupt(input: {
    turnId: string;
    runtimeGeneration: number;
  }): Promise<void>;
  close(deadline: ShutdownDeadline): Promise<void>;
}
```

The approval, question, and plan-review records live beside the contract until
Task 4 gives their pending state an owner. All types contain no provider SDK
values, native callbacks, or raw payloads. Create/resume input contains
canonical target, instance/kind through its
validated `SessionConfiguration`, expected generation, cwd, an event sink, an
interaction sink, and injected IDs/time. `ProviderTurnInput.configuration` is
that exact canonical `SessionConfiguration`; it has no mirrored top-level
selection, model, options, mode, or autonomy fields. `session.updateSettings`
validates and persists a replacement configuration for the immutable provider
instance, but an in-flight turn retains its captured configuration and the new
configuration applies only to the next accepted turn. Adapters perform native
configuration changes immediately before that next turn. `startTurn` receives
DROIDEX `turnId`; native turn IDs are diagnostics only.

`ProviderRuntimeEvent` is a discriminated union for transcript, usage, session
side effects, `binding.updated`, `turn.settled`, warning, and error. The
`binding.updated` member carries `{ providerSessionId?: string; resumeState:
unknown }`. `SessionLifecycle` is its sole consumer and compare-and-swap
persists it by app session, provider instance, and runtime generation before
publishing dependent state; adapters and event flow never write the binding.
`startTurn` resolves only after dispatch is accepted and returns no settlement.
Exactly one generation-checked `turn.settled` event is the sole terminal turn
authority. Every member carries
canonical event ID, target, driver/instance, generation, creation time, optional
turn ID, and optional private native correlation. Raw provider payloads are not
part of this union.

`ProviderCapabilities` is an explicit interface whose required boolean or
closed-enum fields cover modes/autonomy, model-change timing, resume, steer,
interrupt, approvals, questions, plan review, context, compaction, skills,
slash commands, MCP/management, rewind, fork, observational tasks, addressable
children, Mission Control, and browser. `ProviderRuntimeEvent` is declared as
the closed union above, not an open record. Snapshots and runtime errors import
the foundation's closed error/recovery unions and use sanitized
readiness/auth/account/billing labels only. A global database-open failure may
additionally use an app-level startup
diagnostic, but every session-scoped persistence failure carries the selected
`providerInstanceId` and `canonical_persistence_unavailable`.

- [ ] **Step 1: Write failing contract, fake, and event-envelope tests**

Cover invalid kind/instance, selection mismatch, raw payload rejection,
malformed targets, missing generation, exhaustive capabilities, every one of
the 12 error codes, only the seven recovery actions, and sanitized diagnostics.
Build the deterministic fake only after the contract exists. It records
create/resume/turn/steer/interrupt/close calls, can emit before open resolves,
can block or fail each await, exposes private native IDs/resume state, and
reports settlement/cleanup. Compile-test it against `ProviderAdapter`. Prove
provider-event and persistence decoders reject unknown codes/actions and native
error objects or payload fields. Foundation already owns exact bridge command
validation; do not add or duplicate a bridge parser/schema in this task.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/providerTypes.test.ts sidecar/src/providers/providerEvents.test.ts sidecar/src/providers/testing/FakeProviderAdapter.test.ts
```

- [ ] **Step 3: Implement exact contracts without a service layer**

Keep Zod validation at bridge/persistence inputs; use precise TypeScript types
internally. `activate` is one-shot: it flushes the session-owned pre-bind buffer
in order. Reuse the Foundation `sessionPreActivationBuffer` contract exactly:
at most 512 canonical events and 1,048,576 serialized UTF-8 bytes. Count or
multibyte byte overflow fails open, accepts no later events, discards buffered
output, settles native callbacks, and closes the provisional session.
`close(deadline)` before activation has the same discard/settlement behavior.
The supplied `ShutdownDeadline` is absolute and is never replaced with a new
relative timeout.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/providerTypes.test.ts sidecar/src/providers/providerEvents.test.ts sidecar/src/providers/testing/FakeProviderAdapter.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/providerTypes.ts sidecar/src/providers/providerTypes.test.ts sidecar/src/providers/providerEvents.ts sidecar/src/providers/providerEvents.test.ts sidecar/src/providers/testing/ProviderContractHarness.ts sidecar/src/providers/testing/FakeProviderAdapter.ts sidecar/src/providers/testing/FakeProviderAdapter.test.ts
rtk git commit -m "feat(providers): define the provider session contract"
```

### Task 3: Add the static ProviderRegistry and sanitized snapshots

**Files:**

- Create: `sidecar/src/providers/ProviderRegistry.ts`
- Create: `sidecar/src/providers/ProviderRegistry.test.ts`
- Create: `sidecar/src/providers/unavailableProvider.ts`
- Create: `sidecar/src/sensitiveLogRedaction.ts`
- Create: `sidecar/src/sensitiveLogRedaction.test.ts`

`ProviderRegistry` validates unique static instance IDs at construction, maps an
instance to one lazy adapter constructor, returns stable Droid/Codex/Claude
definition order, owns snapshot revision and targeted refresh single-flight,
and validates exact capabilities and provider selections. It constructs an
adapter only on first resolution or refresh, records successful construction
order, and closes constructed adapters in reverse order under the caller's
absolute `ShutdownDeadline`. Each refresh owns an `AbortController`; shutdown
and superseding refresh cancel it, and a refresh-generation check discards late
probe completion. It has no live-session map, cleanup directory, or event
stream; `SessionLifecycle` remains the sole live-session owner. Until adapter
plans land, Codex/Claude use small unavailable adapters with real missing/setup
snapshots and no functional session controls.

- [ ] **Step 1: Write failing registry/status/security tests**

Cover stable order, duplicate instance rejection, wrong driver binding,
targeted refresh isolation and coalescing, equal model IDs scoped by instance,
unsupported operation failing before adapter call, and serialized snapshots/logs
omitting token/key/credential-home/raw-account sentinel values. Also prove lazy
construction, aborted and stale refresh rejection, construction-order recording,
reverse close with the unchanged absolute deadline, cleanup continuation after
one adapter failure, and absence of live-session ownership.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/sensitiveLogRedaction.test.ts
```

- [ ] **Step 3: Implement the static registry and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/sensitiveLogRedaction.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/ProviderRegistry.ts sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/providers/unavailableProvider.ts sidecar/src/sensitiveLogRedaction.ts sidecar/src/sensitiveLogRedaction.test.ts
rtk git commit -m "feat(providers): add the static provider registry"
```

### Task 4: Make interactions provider-neutral

**Files:**

- Create: `sidecar/src/providers/providerInteractions.ts`
- Create: `sidecar/src/providers/droid/DroidInteractions.ts`
- Create: `sidecar/src/providers/droid/DroidInteractions.test.ts`
- Modify: `sidecar/src/SessionInteractions.ts`
- Modify: `sidecar/src/SessionInteractions.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `sidecar/src/normalize.ts`

`SessionInteractions` owns canonical pending approvals, structured questions,
and plan reviews keyed by app session and canonical request ID. It exposes
promise-returning provider-neutral request methods and validates responses.
Provider sessions retain native request IDs/callbacks and map the canonical
result back. Interrupt, close, crash, replacement, and shutdown cancel every
pending request. “Always allow” is session-scoped only when the provider
capability and native adapter support it.

Delete `PermissionRequest.raw` from both protocol mirrors and every renderer
consumer in this same hard cut. Only sanitized title/detail/plan/options cross
the bridge; provider adapters retain native input/callback state privately.

`DroidInteractions` alone imports Factory permission/question types and maps all
existing permission outcomes, mission proposal transitions, and spec exit.
Move the permission-normalization responsibility out of `normalize.ts` here so
the raw native payload is deleted at its source, not merely omitted by the
bridge type.

- [ ] **Step 1: Add failing approval/question/cleanup tests**

Cover concurrent providers with equal native request IDs, every Droid outcome,
structured multi-question answers, cancellation, invalid outcomes, plan review,
session close, adapter crash, replacement generation, shutdown, and sentinel
native-payload absence from bridge serialization.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionInteractions.test.ts sidecar/src/providers/droid/DroidInteractions.test.ts
```

- [ ] **Step 3: Implement, remove Factory imports from shared interactions, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionInteractions.test.ts sidecar/src/providers/droid/DroidInteractions.test.ts sidecar/src/SessionManager.interactions.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/providerInteractions.ts sidecar/src/providers/droid/DroidInteractions.ts sidecar/src/providers/droid/DroidInteractions.test.ts sidecar/src/SessionInteractions.ts sidecar/src/SessionInteractions.test.ts sidecar/src/protocol.ts src/types/bridge.ts sidecar/src/normalize.ts
rtk git commit -m "refactor(providers): normalize runtime interactions"
```

### Task 5: Establish absolute-deadline shutdown before adapter branches

**Files:**

- Create: `sidecar/src/shutdownDeadline.ts`
- Create: `sidecar/src/shutdownDeadline.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.shutdownOrder.test.ts`
- Modify: `sidecar/src/SessionManager.teardown.test.ts`
- Modify: `sidecar/src/SessionRegistry.ts`
- Modify: `sidecar/src/SessionRegistry.test.ts`
- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionInteractions.ts`
- Modify: `sidecar/src/SessionInteractions.test.ts`
- Modify: `sidecar/src/ChildSessions.ts`
- Modify: `sidecar/src/ChildSessions.test.ts`
- Modify: `sidecar/src/SessionTimeline.ts`
- Modify: `sidecar/src/SessionTimeline.test.ts`
- Modify: `sidecar/src/providers/ProviderRegistry.ts`
- Modify: `sidecar/src/providers/ProviderRegistry.test.ts`
- Modify: `sidecar/src/persistence/DroidexDatabase.ts`
- Modify: `sidecar/src/persistence/DroidexDatabase.test.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/src/index.bridge.test.ts`
- Modify: `electron/main.cjs`
- Modify: `electron/mainRegression.test.cjs`
- Modify: `electron/sidecar.cjs`
- Modify: `electron/sidecar.test.cjs`

The first sidecar shutdown trigger creates one absolute monotonic
`ShutdownDeadline`. `SessionManager`, `SessionLifecycle`, child cleanup,
`ProviderSession`, `ProviderRegistry`, and adapter close receive that exact
object; no stage creates a fresh relative timeout. Stop admitting commands and
abort discovery first, invalidate live generations, then cancel and settle all
canonical/native interaction callbacks before discarding provider resources.
Close addressable children before parent provider sessions, close constructed
adapters in reverse construction order, flush `SessionTimeline` and persistence
queues, and close `DroidexDatabase`/SQLite last. Every cleanup is idempotent;
one failure is reported but does not skip later cleanup.

`SessionRegistry` unregisters invalidated live sessions before provider awaits.
`SessionLifecycle` owns parent session close; `ChildSessions` owns child close;
`ProviderRegistry` owns only reverse adapter close and never acquires live
session ownership. `index.ts` shares one shutdown promise across signals/stdin.
Electron's existing six-second supervisor in `electron/sidecar.cjs` remains
the outer hard guard racing that same attempt and does not grant another
cleanup window. `electron/main.cjs` reuses the supervisor's single stop promise
from repeated `before-quit` paths instead of starting another timer.

- [ ] **Step 1: Add deterministic deadline and shutdown-order tests**

Use an injected monotonic clock and controllable cleanup promises, never sleeps.
Prove command admission stops first; discovery is aborted and late refresh is
discarded; generations invalidate before awaits; callbacks settle before native
resources; children precede parents; adapters close in reverse construction
order; timeline flush precedes SQLite close; the exact deadline object reaches
every layer; repeated triggers share one shutdown; and failures/time exhaustion
still attempt all later cleanup. Prove Electron's supervisor sends no second
deadline and retains its single outer guard.

- [ ] **Step 2: Run the failing shutdown tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/shutdownDeadline.test.ts sidecar/src/SessionManager.shutdownOrder.test.ts sidecar/src/SessionManager.teardown.test.ts sidecar/src/SessionRegistry.test.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionInteractions.test.ts sidecar/src/ChildSessions.test.ts sidecar/src/SessionTimeline.test.ts sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/persistence/DroidexDatabase.test.ts sidecar/src/index.bridge.test.ts electron/mainRegression.test.cjs electron/sidecar.test.cjs
```

- [ ] **Step 3: Implement the one canonical shutdown path**

Keep the new deadline module cohesive and below 500 lines. Make only surgical
changes to existing oversized orchestration files; do not introduce a second
shutdown coordinator or adapter live-session map.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/shutdownDeadline.test.ts sidecar/src/SessionManager.shutdownOrder.test.ts sidecar/src/SessionManager.teardown.test.ts sidecar/src/SessionRegistry.test.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionInteractions.test.ts sidecar/src/ChildSessions.test.ts sidecar/src/SessionTimeline.test.ts sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/persistence/DroidexDatabase.test.ts sidecar/src/index.bridge.test.ts electron/mainRegression.test.cjs electron/sidecar.test.cjs
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run electron:check
rtk mise exec node@22 -- npm run quality:file-size
rtk git add sidecar/src/shutdownDeadline.ts sidecar/src/shutdownDeadline.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.shutdownOrder.test.ts sidecar/src/SessionManager.teardown.test.ts sidecar/src/SessionRegistry.ts sidecar/src/SessionRegistry.test.ts sidecar/src/SessionLifecycle.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionInteractions.ts sidecar/src/SessionInteractions.test.ts sidecar/src/ChildSessions.ts sidecar/src/ChildSessions.test.ts sidecar/src/SessionTimeline.ts sidecar/src/SessionTimeline.test.ts sidecar/src/providers/ProviderRegistry.ts sidecar/src/providers/ProviderRegistry.test.ts sidecar/src/persistence/DroidexDatabase.ts sidecar/src/persistence/DroidexDatabase.test.ts sidecar/src/index.ts sidecar/src/index.bridge.test.ts electron/main.cjs electron/mainRegression.test.cjs electron/sidecar.cjs electron/sidecar.test.cjs
rtk git commit -m "refactor(runtime): enforce bounded shutdown ordering"
```

### Task 6: Wrap Factory runtime and normalization in the Droid adapter

**Files:**

- Create: `sidecar/src/providers/droid/DroidProviderAdapter.ts`
- Create: `sidecar/src/providers/droid/DroidProviderAdapter.test.ts`
- Create: `sidecar/src/providers/droid/DroidModeMapping.ts`
- Create: `sidecar/src/providers/droid/DroidModeMapping.test.ts`
- Move/modify: `sidecar/src/DroidRuntime.ts` to
  `sidecar/src/providers/droid/DroidProviderSession.ts`
- Move/modify: `sidecar/src/DroidRuntime.test.ts` to
  `sidecar/src/providers/droid/DroidProviderSession.test.ts`
- Move/modify: `sidecar/src/normalize.ts` to
  `sidecar/src/providers/droid/DroidEventAdapter.ts`
- Move/modify: `sidecar/src/normalize.test.ts` to
  `sidecar/src/providers/droid/DroidEventAdapter.test.ts`
- Modify: `sidecar/src/DroidCliCatalog.ts`
- Modify: `sidecar/src/Environment.ts`

The adapter owns Factory runtime construction, defaults, catalog/status probe,
mode/autonomy mapping, native notifications/stream events, and native
interaction handlers. `DroidProviderSession` owns one `FactorySession`, early
event buffering, one-shot activation, native callback settlement, and
idempotent absolute-deadline close. It uses the Foundation pre-activation
buffer's exact 512-event/1,048,576-byte limits, emits `binding.updated` for
native ID or resume-state changes, and never writes persistence. It provides a
typed Droid-only extension object for existing semantic
context/compaction/MCP/child operations; common code never imports the Factory
SDK.

- [ ] **Step 1: Add failing adapter parity tests**

Port all relevant `normalize.ts` assertions and cover create/resume options,
early notifications, activation ordering, stream normalization, terminal
dedupe, exactly-one `turn.settled`, exact `binding.updated` payloads for resume
state only and native replacement, lifecycle-owned CAS handoff, mode/autonomy
tables, status/catalog sanitization, captured turn/generation interrupt,
absolute-deadline close, callback cleanup, exact count/multibyte byte buffer
boundaries and overflow, raw-payload absence, and current Droid extension
behavior.

- [ ] **Step 2: Run the failing adapter tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/droid/DroidProviderAdapter.test.ts sidecar/src/providers/droid/DroidProviderSession.test.ts sidecar/src/providers/droid/DroidEventAdapter.test.ts sidecar/src/providers/droid/DroidModeMapping.test.ts
```

- [ ] **Step 3: Implement the wrapper and delete superseded root implementations**

Keep each file cohesive and below 500 lines. If the old normalizer contains
multiple real responsibilities, split only into Droid event normalization and
Droid mission/child signal translation; do not create one-function wrappers.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/droid/*.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run quality:file-size
rtk git add -A -- sidecar/src/DroidRuntime.ts sidecar/src/DroidRuntime.test.ts sidecar/src/normalize.ts sidecar/src/normalize.test.ts sidecar/src/providers/droid/DroidProviderAdapter.ts sidecar/src/providers/droid/DroidProviderAdapter.test.ts sidecar/src/providers/droid/DroidProviderSession.ts sidecar/src/providers/droid/DroidProviderSession.test.ts sidecar/src/providers/droid/DroidEventAdapter.ts sidecar/src/providers/droid/DroidEventAdapter.test.ts sidecar/src/providers/droid/DroidModeMapping.ts sidecar/src/providers/droid/DroidModeMapping.test.ts sidecar/src/DroidCliCatalog.ts sidecar/src/Environment.ts
rtk git commit -m "refactor(droid): implement the provider adapter"
```

### Task 7: Route lifecycle and event flow through captured provider sessions

**Files:**

- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionEventFlow.ts`
- Modify: `sidecar/src/SessionEventFlow.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionManager.eventFlow.test.ts`
- Modify: `sidecar/src/SessionManager.inFlightRaces.test.ts`
- Modify: `sidecar/src/sessionHelpers.ts`

Lifecycle resolves and validates the exact adapter before provider work, opens
a session, compare-and-swap persists its private binding/generation, then calls
one-shot `activate`. Every turn is created durably before `startTurn` and
settled once only by `turn.settled`. `startTurn` completion records acceptance,
never terminal state. Resume uses the exact persisted adapter and opaque resume
state. A `binding.updated` event carries optional `providerSessionId` and opaque
`resumeState`; only `SessionLifecycle` persists it through the current app
session/provider instance/runtime generation compare-and-swap before dependent
publication. Send and steer use the exact `SessionConfiguration` captured for
the accepted turn. `session.updateSettings` validates and persists configuration
for the immutable provider instance but affects only the next accepted turn;
there are no mirrored top-level model/options/mode/autonomy values.
Send/steer/interrupt/close use the `ProviderSession` captured in `LiveSession`,
never look it up by native ID. Interrupt revalidates the captured `{ turnId,
runtimeGeneration }` immediately before native mutation. Close receives the
one application-owned absolute `ShutdownDeadline`.

`SessionEventFlow` accepts only `ProviderRuntimeEvent`. It rejects raw/native
payload fields, wrong target, instance, session, generation, duplicate event
ID, and post-terminal output
before `SessionTimeline` persistence. It preserves side-effect-before/after
ordering and record-before-emit.

- [ ] **Step 1: Turn the Task 1 characterization cases into passing contract tests**
- [ ] **Step 2: Run them and verify old Factory-typed lifecycle fails**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionEventFlow.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionManager.eventFlow.test.ts sidecar/src/SessionManager.inFlightRaces.test.ts
```

- [ ] **Step 3: Implement lifecycle routing and delete common Factory imports**

Per-app mutating commands serialize. Resume stays single-flight. Invalidate the
generation before awaiting replacement/close. A close racing open discards the
unactivated bounded buffer, settles callbacks, and cannot resurrect the
session. Add exact binding tests for resume-state-only updates, native ID plus
resume-state replacement, stale generation rejection, wrong-instance
rejection, CAS failure with no dependent publication, and two ordered updates.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionEventFlow.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionManager.eventFlow.test.ts sidecar/src/SessionManager.inFlightRaces.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/SessionLifecycle.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionEventFlow.ts sidecar/src/SessionEventFlow.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionManager.eventFlow.test.ts sidecar/src/SessionManager.inFlightRaces.test.ts sidecar/src/sessionHelpers.ts
rtk git commit -m "refactor(sessions): route lifecycle through providers"
```

### Task 8: Preserve Droid-only features behind exact capability gates

**Files:**

- Modify: `sidecar/src/SessionCompaction.ts`
- Modify: `sidecar/src/sessionCompactionExecution.ts`
- Modify: `sidecar/src/SessionContext.ts`
- Modify: `sidecar/src/ChildSessions.ts`
- Modify: `sidecar/src/MissionControlPolicy.ts`
- Modify: `sidecar/src/McpSettings.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionContext.test.ts`
- Modify: `sidecar/src/SessionCompaction.test.ts`
- Modify: `sidecar/src/SessionCompaction.manual.test.ts`
- Modify: `sidecar/src/SessionCompaction.automatic.test.ts`
- Modify: `sidecar/src/ChildSessions.test.ts`
- Modify: `sidecar/src/MissionControlPolicy.test.ts`
- Modify: `sidecar/src/SessionManager.settings.test.ts`
- Modify: `sidecar/src/SessionManager.mcp.test.ts`
- Modify: `sidecar/src/SessionManager.historyAndChildren.test.ts`
- Modify: `sidecar/src/SessionManager.compactionLifecycle.test.ts`
- Modify: `sidecar/src/SessionManager.browserRouting.test.ts`

Route Droid-only operations through the typed Droid extension after checking
the session’s provider and exact capability. A non-Droid or unavailable
provider fails before mutation with provider instance, operation, missing
capability, and closed recovery action. Do not put optional Droid methods on
the common `ProviderSession` contract.

- [ ] **Step 1: Add failing capability and Droid-parity tests**

Cover context, manual/automatic compaction, model settings, children, Mission
Control, browser, MCP management, skills/tools, rewind, fork, rename, and all
unsupported-provider paths.

- [ ] **Step 2: Implement semantic Droid extension routing**
- [ ] **Step 3: Run the complete Droid checkpoint**

```bash
rtk mise exec node@22 -- npm run format:check
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run test
rtk mise exec node@22 -- npm --prefix sidecar run test
rtk mise exec node@22 -- npm run quality:file-size
rtk mise exec node@22 -- npm run quality:deadcode
rtk mise exec node@22 -- npm run quality:boundaries
rtk mise exec node@22 -- npm run build
```

- [ ] **Step 4: Commit and record the adapter-branch checkpoint**

```bash
rtk git add sidecar/src/SessionCompaction.ts sidecar/src/sessionCompactionExecution.ts sidecar/src/SessionContext.ts sidecar/src/ChildSessions.ts sidecar/src/MissionControlPolicy.ts sidecar/src/McpSettings.ts sidecar/src/SessionManager.ts sidecar/src/SessionContext.test.ts sidecar/src/SessionCompaction.test.ts sidecar/src/SessionCompaction.manual.test.ts sidecar/src/SessionCompaction.automatic.test.ts sidecar/src/ChildSessions.test.ts sidecar/src/MissionControlPolicy.test.ts sidecar/src/SessionManager.settings.test.ts sidecar/src/SessionManager.mcp.test.ts sidecar/src/SessionManager.historyAndChildren.test.ts sidecar/src/SessionManager.compactionLifecycle.test.ts sidecar/src/SessionManager.browserRouting.test.ts
rtk git commit -m "refactor(droid): isolate provider-specific capabilities"
rtk git rev-parse HEAD
```

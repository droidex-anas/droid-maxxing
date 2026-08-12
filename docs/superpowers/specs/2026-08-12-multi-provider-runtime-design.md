# Multi-Provider Runtime v1

## Status

Approved on 2026-08-12. This document is the design authority for the
implementation plan. Provider implementation has not begun.

The integration branch is integration/multi-provider-v1, created in the
isolated worktree .worktrees/integration-multi-provider-v1 from origin/main at
6890d1f1698a7944c23c8c31abb4fd612583d33d.

## Verified baselines

The design was prepared from:

- DROIDEX origin/main at
  6890d1f1698a7944c23c8c31abb4fd612583d33d, the v1.1.2 merge;
- T3 Code origin/main at
  849bac8946c40420174b4187e36fcf17b5ea7cc4;
- T3 Codex and Claude provider trees that are unchanged between
  5a84614809b6e853b872f9e57ff4b97e9df5df02 and the pinned T3 head;
- T3's generated Codex app-server protocol reference
  678157acaa819d5510adfe359abb5d0392cfe461; and
- T3's resolved Claude Agent SDK version 0.3.170.

The isolated worktree was installed and tested with Node.js 22.23.1. The root
and sidecar test suites passed before this document was added.

The implementation-start refresh was performed on 2026-08-12. Changes since
the prior reviewed head were outside the mapped provider trees. Never track a
moving upstream branch during development or at runtime.

## Outcome

DROIDEX will provide one provider-neutral desktop interface that can run Droid,
Codex, and Claude sessions simultaneously.

- Droid remains the default provider.
- A provider is selected before creating a session.
- A session is permanently bound to that exact provider instance.
- Codex runs through Codex app-server.
- Claude runs through the official Claude Agent SDK and the user's local Claude
  harness.
- Existing Droid behavior remains available.
- Codex and Claude expose the common DROIDEX experience plus truthful
  provider-specific capabilities.
- Settings provide provider setup, discovery, defaults, status, diagnostics,
  and capability visibility.

The result is a DROIDEX backend with a narrow provider seam. It is not an
embedded T3 server and it is not a rewrite of DROIDEX as a T3 client.

## Product principles

1. DROIDEX owns the product domain.
2. Provider identities never become UI identities.
3. Every piece of mutable state has one owner.
4. Provider differences are translated at the provider seam.
5. Unsupported behavior is visible and rejected, never simulated.
6. Every asynchronous provider result is generation-checked.
7. Every user-visible event is persisted before publication.
8. Existing paging and responsiveness must not regress.
9. New production files remain below 500 lines.
10. Compatibility with old DROIDEX state is deliberately not implemented.

## Non-goals

The first release does not include:

- migration of the existing DROIDEX database;
- automatic import of Factory, Codex, Claude, or T3 histories;
- provider switching inside an existing session;
- dynamic third-party provider plugins or provider hot reload;
- multiple accounts or shadow homes per provider;
- T3's Effect runtime, RPC server, event store, checkpoints, cloud services,
  remote environments, analytics, or web UI;
- cross-provider conversation continuation;
- generic Mission Control for Codex or Claude;
- observational subagents presented as controllable child sessions;
- a new transcript virtualization system; or
- unrelated loading, rendering, or dependency-upgrade work.

Existing bounded history paging remains required. Performance and virtualization
improvements are a later change.

## Decision 1: selectively port T3 provider behavior

Port the useful T3 provider behavior into focused, plain-TypeScript DROIDEX
modules:

- provider driver and instance identity;
- provider-scoped discovery and capabilities;
- Codex process, protocol, session, and normalization behavior;
- Claude environment, query, session, permission, task, and normalization
  behavior;
- strict session-to-provider binding rules; and
- provider-specific fixtures that prove behavior.

T3 is a reviewed behavioral and provenance source. Its framework architecture
is not imported.

Embedding the T3 server was rejected because it would add another WebSocket
protocol, authentication boundary, settings store, database, process lifecycle,
event model, and session owner.

Replacing the DROIDEX backend was rejected because it would rewrite working
Droid, Mission Control, child-session, browser, terminal, git, history, and
renderer behavior.

## Decision 2: retain the existing DROIDEX owners

The canonical architecture is:

~~~text
DROIDEX renderer and bridge
          |
SessionManager: construction and command dispatch
          |
SessionLifecycle / SessionRegistry / SessionStore
          |
ProviderRegistry
    |-- DroidProviderAdapter   -> Droid provider sessions
    |-- CodexProviderAdapter   -> Codex app-server sessions
    '-- ClaudeProviderAdapter  -> Claude Agent SDK sessions
          |
canonical ProviderEvent values
          |
SessionEventFlow -> SessionTimeline -> SQLite -> renderer
~~~

Ownership is explicit:

- SessionManager constructs modules, dispatches commands, and coordinates
  shutdown. It does not own provider sessions, catalogs, or normalization.
- SessionRegistry owns live application sessions, stable appSessionId lookup,
  and immutable provider-instance binding.
- SessionLifecycle owns create, resume, send, steer, interrupt, settings updates,
  close, per-session queues, turn IDs, durable binding updates, and generation
  checks.
- SessionEventFlow owns lifecycle validation, deduplication, terminal gating,
  and existing state side effects.
- SessionTimeline owns ordered persistence, paging, and record-before-emit.
- ProviderRegistry owns the static built-in adapters, sanitized discovery, lazy
  adapter construction, and bounded reverse-order shutdown.
- ProviderAdapter owns one provider instance's discovery, native session
  creation and resume, configuration translation, defensive live-session
  cleanup, and deadline-bounded close.
- ProviderSession owns one live native conversation. It accepts turns, performs
  truthful steering, interrupts only a captured turn/generation, emits canonical
  events and durable-binding updates, and closes idempotently by an absolute
  deadline. It never writes application persistence.

The provider lifecycle contract has one terminal authority:

~~~ts
interface ProviderSession {
  readonly providerSessionId: string;
  readonly initialResumeState: unknown;
  activate(): void;
  startTurn(input: ProviderTurnInput): Promise<void>; // acceptance only
  steer(input: ProviderSteerInput): Promise<void>;
  interrupt(input: {
    turnId: string;
    runtimeGeneration: number;
  }): Promise<void>;
  close(deadline: ShutdownDeadline): Promise<void>;
}

interface ProviderAdapter {
  probe(signal: AbortSignal): Promise<ProviderSnapshot>;
  create(input: ProviderSessionCreateInput): Promise<ProviderSession>;
  resume(input: ProviderSessionResumeInput): Promise<ProviderSession>;
  close(deadline: ShutdownDeadline): Promise<void>;
}
~~~

`startTurn` resolves only when the provider has accepted dispatch. Exactly one
canonical `turn.settled` event completes a turn. A returned terminal result is
forbidden because it creates a second settlement path.

The first release has static instance IDs droid, codex, and claude. The
providerInstanceId contract remains explicit even though multiple instances per
driver are deferred.

There is no ProviderService, ProviderAdapterRegistry facade, provider session
directory, provider event bus, hot-reload reconciler, or unknown-driver shadow
state.

Droid-only compaction, rewind, Mission Control, addressable children, and
Factory MCP management do not become required ProviderSession methods.

## Decision 3: canonical identity and immutable binding

| Identity | Owner | Invariant |
| --- | --- | --- |
| providerDriverKind | provider definition | Closed v1 union: droid, codex, claude |
| providerInstanceId | runtime | Exact routing identity |
| appSessionId | DROIDEX | Generated before provider work and permanent |
| turnId | DROIDEX | Generated for every accepted turn |
| childSessionId | DROIDEX parent | Stable only with parentAppSessionId |
| providerSessionId | adapter | Opaque, replaceable, and sidecar-only |
| providerTurnId | adapter | Optional diagnostic correlation only |
| runtimeGeneration | SessionLifecycle | Rejects stale work and events |

Required invariants:

- appSessionId is never derived from providerSessionId.
- Native identity is scoped by providerInstanceId.
- Renderer commands use only appSessionId or canonical parent/child identity.
- providerDriverKind and providerInstanceId never change after creation.
- An instance ID cannot be rebound to another driver while sessions reference
  it.
- providerSessionId and resume state may change without changing appSessionId.
- Equal model ID strings from different providers are different selections.
- Children never enter top-level navigation.
- A provider task becomes an addressable child only when it supports
  independent open, send, interrupt, and resume behavior.

The canonical target is:

~~~ts
type SessionTarget =
  | { kind: "session"; appSessionId: string }
  | {
      kind: "child";
      parentAppSessionId: string;
      childSessionId: string;
    };
~~~

Ambiguous lookups that accept either appSessionId or providerSessionId are
deleted in the hard cut.

## Decision 4: fresh canonical persistence

The canonical database is:

~~~text
$DROIDEX_USER_DATA_DIR/state/droidex.sqlite
~~~

It is the sole application source of truth for:

- session and child summaries;
- immutable provider bindings;
- opaque provider resume state;
- turns and full normalized transcript payloads;
- stable transcript paging;
- lifecycle and failure state; and
- application-owned metadata.

Focused ownership is:

- DroidexDatabase: connection, schema, transactions, and shutdown;
- SessionStore: summaries, bindings, children, and restart state; and
- TranscriptStore: turns, canonical events, deduplication, and page queries.

`DroidexDatabase` is the only connection owner and the only module with
`close()`. `SessionStore` and `TranscriptStore` share that connection and do not
close it independently. `summary_json` contains only non-authoritative summary
fields; application session identity, provider identity, lifecycle/failure
state, generation, and timestamps are projected from normalized columns on
read and cannot diverge from JSON.

These modules must own real invariants and queries. One-method forwarding store
wrappers are prohibited.

Create ordering is:

1. Validate the command and resolve durable `clientRef` deduplication; an
   existing ref returns its exact canonical session without provider work.
2. Allocate appSessionId and the first turnId.
3. Insert the provisional summary, immutable binding, and turn transactionally.
4. Resolve and validate the exact ProviderAdapter.
5. Register event handling before native startup can emit.
6. Create the provider session.
7. Persist providerSessionId, resume state, and runtime generation.
8. Activate the bounded event buffer and start the first turn.

A provider create call receives the canonical target and generation before
native initialization. Transcript events that arrive before step 7 are buffered
inside the new ProviderSession and flush only after the native binding is
durable. The pre-activation buffer has explicit event-count and encoded-byte
limits. Overflow fails startup, closes the provider session, discards buffered
content, and persists only a sanitized diagnostic. Create failure follows the
same rule.

A provider-start failure leaves a visible failed session with an explicit retry
or removal action.

`session.retryStart` is valid only for a visible failed session. It preserves
the immutable provider instance and exact stored session configuration,
invalidates the old generation, allocates a new turn ID, and retries the same
operation: create if no native binding was durably established, otherwise exact
resume. It never changes providers or falls back to a fresh resume. A failed
retry remains visible. `session.removeFailed` is valid only while the session is
failed and not live; it transactionally removes only DROIDEX-owned canonical
rows and emits `session.removed`. It never deletes provider-native history.

Resume always targets the exact persisted instance. Missing provider history or
a rejected native resume stays a visible failure. It never creates an empty
replacement conversation.

Opaque resume state is decoded only by the owning adapter. Invalid resume state
fails fast rather than being interpreted by shared lifecycle code.

Native session replacement and resume-cursor changes arrive as a canonical
`binding.updated` provider event containing opaque resume state and optional
replacement provider session ID. `SessionLifecycle` persists it with
appSessionId, providerInstanceId, and runtimeGeneration compare-and-swap before
publishing dependent state. Adapters cannot access `SessionStore`.

Hard-cut rules:

- no old database migration, compatibility fields, or old schema reader;
- existing Factory history and old databases remain untouched;
- no automatic deletion or automatic history import;
- a mismatched canonical schema fails with its path and recovery action;
- renderer session snapshots are versioned so old sessions cannot reappear; and
- Factory JSONL stops being application history truth only after Droid records
  and restores through the canonical store.

Canonical transcript search remains bounded. It preserves the existing maximum
work budget equivalent to 150 history files, 40 MB scanned text, 25 returned
sessions, three snippets per session, cooperative yielding, and stale-query
cancellation, or replaces the scan with a bounded indexed query proven to meet
the same result and cancellation limits. An unbounded SQLite scan is forbidden.

Provider-native history exists only to resume its provider. Any future importer
is an explicit one-way product feature.

## Decision 5: capabilities and model selection

Capabilities are published per instance because executable versions,
authentication, and provider behavior can differ.

The snapshot describes:

- supported interaction modes and autonomy levels;
- the effective provider-native enforcement profile;
- model catalog and provider-owned option descriptors;
- model-change behavior;
- resume, steer, and interrupt;
- approvals and structured questions;
- context and compaction;
- skills, slash commands, and MCP;
- rewind or fork;
- observational tasks and addressable children;
- Mission Control; and
- browser integration.

Unsupported operations fail before provider mutation with providerInstanceId,
the requested operation, the missing capability, and a recovery action. The UI
hides unavailable creation choices and the sidecar always revalidates.

There is one canonical session-configuration object used verbatim by create,
update, persistence, bridge types, and renderer state:

~~~ts
interface ProviderSelection {
  providerInstanceId: ProviderInstanceId;
  modelId: string;
  options: Record<string, string | number | boolean>;
}

interface SessionConfiguration {
  providerSelection: ProviderSelection;
  interactionMode: "auto" | "spec" | "agi";
  autonomy: "off" | "low" | "medium" | "high";
}
~~~

`SessionSummary.configuration` is the sole parent-session owner of model,
provider options, mode, and autonomy. Legacy top-level `modelId`,
`reasoningEffort`, `interactionMode`, and `autonomy` fields are removed in the
hard cut; reasoning effort and service tier are provider-owned options.
Droid-only worker and validator settings live in a separately named optional
`droidMissionConfiguration`, valid only for a Droid session. The renderer never
infers behavior from model names.

Provider defaults in Settings seed new drafts only. An explicit
`session.updateSettings` may change model/options/mode/autonomy for a bound
session only when the selected instance advertises the capability. The provider
instance is immutable, an in-flight turn keeps its captured configuration, and
the new validated configuration applies to the next accepted turn. Adapters
perform any native `setModel` or permission-mode call immediately before that
turn; no hidden eager mutation occurs.

## Decision 6: interaction modes and autonomy

DROIDEX retains auto, spec, and agi.

| DROIDEX mode | Droid | Codex | Claude |
| --- | --- | --- | --- |
| auto | native auto | default collaboration | normal query |
| spec | native spec | plan collaboration | plan mode |
| agi | native AGI | unsupported | unsupported |

Mission Control stays Droid-only. Invalid agi creation fails before provider
startup.

DROIDEX also retains off, low, medium, and high autonomy.

Codex translation is:

| DROIDEX autonomy | Codex policy |
| --- | --- |
| off | untrusted plus read-only |
| low | on-request plus workspace-write with user review |
| medium | on-request plus workspace-write with automatic review |
| high | never plus danger-full-access |

Claude translation requires behavior rather than an enum rename:

- off installs an explicit tool gate preserving DROIDEX approval semantics;
- low uses a tested safe allow-set and asks for everything else;
- medium uses Claude's native automatic profile and visibly describes its
  effective semantics; and
- high uses bypassPermissions only with the SDK danger opt-in.

The adapter publishes the effective profile and provider or organization
restrictions. No level silently falls back. Unsupported levels stay disabled
until their mapping is implemented and tested.

Translations are table-driven and tested. Changes apply to a new turn and never
retroactively alter an in-flight turn.

## Decision 7: canonical events and interactions

Each adapter converts native protocol values directly into one compact
`CanonicalEvent` envelope. Its payload is a closed discriminated union covering:

- session and turn lifecycle;
- assistant text, thinking, plan, and command output;
- tool lifecycle;
- approval and question lifecycle;
- usage;
- observational provider-agent activity;
- durable binding updates;
- exactly-one turn settlement;
- warnings; and
- errors.

Every canonical event includes `eventId`, `createdAt`, `SessionTarget`, provider
kind and instance, runtimeGeneration, optional turnId, and bounded private native
correlation. `TranscriptStore.append` accepts this full envelope, not the
renderer's historical `TranscriptEvent` shape. `eventId` is the durable unique
identity. When projecting a transcript payload to the current renderer bridge,
`eventId` becomes `TranscriptEvent.id`, target becomes the existing
app/source-session fields, and SQLite `event_order` becomes `seq`. Provider
identity, generation, and private native correlation remain sidecar-owned.

Re-appending an `eventId` is idempotent only when the canonical target,
generation, provider identity, turn, and normalized payload are byte-equivalent
after canonical encoding. A collision with different content fails visibly and
allocates no new order.

Raw provider payloads are not bridge payloads and are not normally persisted.
Opt-in protocol diagnostics are redacted and never contain credentials or
authenticated content.

Event guarantees:

- handlers register before provider initialization;
- correlation stays inside the owning ProviderSession;
- wrong-instance, wrong-session, stale, duplicate, and post-terminal events are
  rejected deterministically;
- `turn.settled` is the sole terminal authority; provider method return values
  cannot settle a turn;
- SessionEventFlow retains state transitions and terminal gating;
- SessionTimeline persists before bridge emission;
- persistence failure emits no undurable transcript; and
- equal-timestamp pages remain stable and gap-free.

ProviderSession retains raw request IDs and callbacks. SessionInteractions owns
canonical approvals, questions, and plan reviews. Renderer responses target the
exact app session and canonical request ID.

Canonical approval requests expose only bounded kind/title/detail/plan/options;
the existing bridge `raw` field is deleted. Structured questions carry exact
provider question keys, options, and `multiSelect`; answers return exact-keyed
string arrays so scalar and multi-select native forms can be reconstructed only
inside the adapter. Plan review decisions are the closed Implement, Iterate with
feedback, or Cancel variants. No native callback or authenticated payload
crosses the bridge.

Interrupt, close, crash, replacement, and shutdown settle every pending native
callback as denied or cancelled. Always-allow is translated only when the
provider supports a native session-scoped permission update.

Claude ExitPlanMode is not held open as a fake callback. ClaudeSession captures
the plan, safely terminates the native tool request, and emits a nonblocking
plan review. Implement starts or steers a later normal-mode turn; Iterate stays
in plan mode and sends feedback.

## Decision 8: provider implementations

### Droid

DroidProviderAdapter wraps the current Factory SDK behavior.

Factory SDK types, event normalization, defaults, CLI catalogs, permission
outcomes, MCP translation, child discovery, Mission Control notifications,
context details, and compaction stay inside the Droid provider area.

Existing Droid behavior must remain unchanged through the same public bridge
entry points. Extraction is incomplete until Factory types no longer define the
shared session seam.

### Codex

Codex uses the installed Codex CLI and app-server.

Focused modules own:

- executable, version, account, model, and capability discovery;
- minimal JSONL transport;
- validated supported protocol envelopes;
- provider adapter and one live session;
- native event normalization;
- mode and autonomy translation; and
- deterministic transport and adapter fixtures.

One live DROIDEX Codex session owns one app-server process and one root Codex
thread in v1. This favors isolation and simple cleanup over process pooling.

The implementation must:

- derive behavior from the latest reviewed T3 adapter at the frozen T3 commit;
- port only required official generated protocol types;
- retain applicable Apache-2.0 notices and upstream references;
- use truthful DROIDEX client information;
- support an exact tested Codex CLI allowlist;
- fail clearly outside that allowlist;
- register requests and notifications before initialize;
- initialize with
  `{ clientInfo: { name, title, version }, capabilities: { experimentalApi: true } }`;
- preserve and echo both string and numeric JSON-RPC server-request IDs;
- enforce explicit stdout line/frame and buffered-stderr byte limits;
- resolve POSIX executables and Windows command shims without shell injection;
- drain stderr without logging authenticated payloads;
- settle pending requests on EOF and process failure;
- terminate the whole spawned process tree within the shared deadline;
- retry only idempotent discovery after overload; and
- never replay turn-start automatically.

Plan mode, questions, skills, MCP management, and observational subagents ship
only when the exact tested app-server version provides the required behavior.
Capabilities describe any absence.

### Claude

Claude uses the official Claude Agent SDK pinned exactly to the reviewed
version, plus the user's local Claude harness and provider-owned credentials.

Focused modules own:

- executable, home, version, authentication, account, model, and capability
  discovery;
- provider adapter and one live session;
- SDK Query and prompt-stream lifecycle;
- permissions and structured questions;
- messages, usage, plans, and task normalization;
- mode and autonomy translation; and
- deterministic SDK-facing fixtures.

One live DROIDEX Claude session owns one long-lived Query and prompt iterator.

The implementation must:

- preserve the SDK-required environment without overriding HOME;
- never capture, relay, proxy, or persist Claude OAuth credentials;
- never impersonate Anthropic clients;
- expose sanitized authentication, API-provider, and billing-route status;
- use official local subscription, API-key, and cloud-provider paths only when
  the SDK and current Anthropic policy permit them;
- preserve exact question keys and multi-select behavior;
- settle permission callbacks on every terminal path;
- persist opaque Claude session and assistant resume cursors;
- fail visibly when native resume history is unavailable;
- use genuine prompt-stream steering;
- treat provider tasks as activity unless independently addressable; and
- verify SDK assets and platform packages in the packaged sidecar.

Before Claude runtime implementation, the pinned SDK's all-rights-reserved
license and referenced Anthropic legal agreements receive an explicit human
use/redistribution go/no-go. The packaging spike excludes optional provider
platform binaries unless separately approved. Claude setup remains a release-
policy verification gate. DROIDEX does not implement custom Claude login or
token handling.

## Decision 9: settings and discoverability

Settings are a first-class part of the integration.

They include:

- default provider, initially Droid;
- separate Droid, Codex, and Claude cards;
- installed executable and version;
- readiness and sanitized authentication or account state;
- API-provider or billing-route description when safely available;
- actionable missing, unauthenticated, unsupported-version, and configuration
  diagnostics;
- refresh or recheck;
- per-provider default model and provider-owned options;
- per-provider mode and autonomy defaults;
- visible capability summaries; and
- setup and recovery documentation.

The renderer stores no OAuth tokens, API keys, credential homes, or raw account
payloads.

Settings semantics:

- changing defaults affects only new drafts and sessions;
- active sessions ignore later default changes and retain their provider;
- explicit in-session settings changes apply only to the next turn through
  `session.updateSettings` and never retarget the provider;
- draft selections are remembered independently per provider;
- switching draft provider restores its last valid selection;
- stale models require explicit user replacement;
- provider choice locks when creation begins;
- Use another provider creates a new session or fork;
- Mission Control, workers, and validators appear only for capable Droid
  instances; and
- status refresh never mutates active bindings.

Focused renderer ownership lives under src/features/providers. Expected
responsibilities are provider state and selectors, provider/model selection,
provider settings, and provider status cards. The exact file split stays small;
empty folders and one-function modules are prohibited.

SettingsPanel, PromptInput, ModelSelectorPopover, and useStore compose this
feature through small values and operations. They do not own provider
lifecycles or catalogs.

The bridge publishes provider snapshots and refresh operations. Session create
requires the exact `SessionConfiguration` object.

Every inbound bridge frame is size-bounded before `JSON.parse`, then decoded by
an exact runtime schema before reaching `SessionManager`. Unknown commands,
fields, provider instances, option keys/value shapes, oversized arrays/strings,
and malformed settings fail closed with a structured error. A TypeScript cast is
not validation. The sidecar applies a WebSocket/frame ceiling and smaller
command-specific bounds; tests prove malformed or oversized provider selection
cannot invoke an adapter.

## Decision 10: lifecycle, concurrency, and shutdown

Per-session coordination:

- mutating commands serialize per appSessionId;
- unrelated provider sessions run concurrently;
- create deduplicates by clientRef;
- resume is single-flight per appSessionId;
- interrupt bypasses the ordinary send queue, captures `{turnId,
  runtimeGeneration}`, revalidates both immediately before native mutation, and
  targets only that turn;
- every provider await captures binding, instance, generation, turn, close, and
  shutdown state;
- continuations revalidate before committing state; and
- close invalidates generation and unregisters live work before native cleanup.

Steering uses truthful provider behavior:

- Codex uses native steering only when the allowlisted app-server supports it;
- Claude uses its prompt iterator;
- Droid retains existing interrupt-and-queue behavior; and
- the UI exposes one semantic operation gated by capability.

Crash isolation:

- a Codex process failure settles only its session;
- a Claude query failure settles only its session;
- a Droid failure does not disturb Codex or Claude;
- a shared adapter failure settles only its own sessions;
- every affected turn reaches exactly one terminal state; and
- interactions settle before provider resources are discarded.

Shutdown ordering:

1. Stop admitting commands.
2. Abort discovery refresh and invalidate stale completions.
3. Invalidate live generations.
4. Cancel pending approvals and questions.
5. Close children, then parent ProviderSessions.
6. Terminate provider processes within one total deadline.
7. Close adapters in reverse construction order.
8. Flush timeline and persistence queues.
9. Close SQLite.

The first sidecar shutdown trigger creates one absolute monotonic
`ShutdownDeadline`, propagated unchanged through SessionLifecycle,
ProviderSession, ProviderAdapter, task cleanup, and process-tree termination.
No child, provider, or escalation receives a fresh relative timeout. The
current Electron six-second supervisor is the outer hard guard and races the
same shutdown attempt; it never adds a second cleanup window. Provider-local
budgets, including Claude task stops, clamp to the remaining shared deadline.

ProviderRegistry constructs adapters lazily, records construction order, aborts
and generation-checks each in-flight refresh, and closes constructed adapters
in reverse order. SessionLifecycle remains the owner of live application
sessions; adapter close only performs a defensive bounded sweep of its own
native resources. Shutdown is idempotent. One cleanup failure is reported
without preventing later cleanup, and deterministic tests prove no Droid,
Codex, Claude, sidecar, or descendant process survives the outer guard.

## Decision 11: branch and parallel development

The umbrella branch is integration/multi-provider-v1.

Sequence:

1. Characterize current Droid behavior.
2. Create fresh canonical persistence with Droid only.
3. Introduce the minimal provider seam and put Droid behind it.
4. Establish a tested shared-provider checkpoint.
5. Fork isolated Codex and Claude worktrees from that checkpoint.
6. Implement both adapters concurrently in provider-owned directories.
7. Merge their small commits without squashing.
8. Integrate settings and renderer selection on the umbrella branch.
9. Run the cross-provider release gate.

Adapter worktrees own sidecar/src/providers/codex or
sidecar/src/providers/claude plus preassigned exact dependency and test changes.
They do not independently edit shared contracts, registration,
SessionLifecycle, SessionManager, protocol mirrors, or renderer state.

Shared contract changes are proposed to and landed by the integration owner.
This prevents competing abstractions.

Every commit must build, pass focused tests, have one purpose, avoid dormant
infrastructure, avoid fake controls, and preserve useful history.

## Implementation phases

### Phase 1: characterization and canonical storage

- Add production-entry-point characterization for provider-facing Droid
  behavior.
- Introduce the cohesive database, session, and transcript owners.
- Create the fresh schema and exact recovery diagnostic.
- Hard-cut parent session configuration to the single canonical nested object.
- Generate appSessionId before provider work.
- Persist immutable bindings and full normalized transcripts.
- Move list, search, restore, and paging to the canonical store.
- Add exact failed-start retry and removal commands.
- Version renderer session snapshots.
- Remove old native-history truth only after Droid restores from the new store.

### Phase 2: minimal provider seam and Droid

- Add compact provider contracts and a deterministic fake.
- Replace bridge command casts with bounded runtime validation.
- Add the static ProviderRegistry.
- Normalize native events inside the Droid adapter.
- Route lifecycle operations through the captured ProviderSession.
- Capability-gate Droid-only behavior.
- Remove Factory SDK types from shared lifecycle and interactions.
- Establish children-first, reverse-adapter, SQLite-last shutdown under the
  shared absolute deadline before Codex or Claude work begins.
- Prove no visible Droid regression.

### Phase 3: parallel Codex and Claude vertical slices

Codex:

- transport and exact protocol fixtures;
- discovery, status, account, models, and options;
- create, resume, send, events, interrupt, and close;
- approvals and questions;
- mode and autonomy mapping;
- recovery, crash, and shutdown;
- supported skills, MCP, and observational agent activity; and
- packaged authenticated smoke.

Claude:

- exact SDK dependency and packaging spike;
- environment, discovery, status, account, models, and options;
- create, resume, query stream, events, interrupt, steer, and close;
- approvals, structured questions, and plan review;
- mode and autonomy enforcement;
- recovery, tasks, crash, and shutdown;
- supported skills, slash commands, MCP, and attachments; and
- packaged authenticated smoke.

Each adapter lands a small end-to-end slice before expanding capabilities.

### Phase 4: settings and renderer

- Add provider state and selectors.
- Add provider settings cards and status refresh.
- Add scoped model selection and remembered defaults.
- Add provider badges and locked live bindings.
- Remove ambiguous provider wording and commands.
- Gate every control from the provider snapshot.
- Preserve Droid-first onboarding and add Codex and Claude setup.

### Phase 5: convergence and release

- Run simultaneous sessions across all adapters.
- Prove restart, crash isolation, interaction settlement, and shutdown.
- Complete attribution, dependency inventory, architecture, setup, recovery,
  and release documentation.
- Run deterministic and authenticated packaged smokes.
- Demonstrate Droid default and explicit Codex or Claude selection.

## Error and recovery model

The bridge/persistence contract uses one closed error shape:

~~~ts
interface ProviderError {
  code:
    | "invalid_provider_configuration"
    | "missing_executable"
    | "unauthenticated_provider"
    | "unsupported_provider_version"
    | "unavailable_provider_instance"
    | "unsupported_capability"
    | "native_session_start_failed"
    | "incompatible_provider_protocol"
    | "provider_process_exited"
    | "interaction_cancelled"
    | "stale_provider_operation"
    | "canonical_persistence_unavailable";
  providerInstanceId: ProviderInstanceId;
  message: string;
  recoveryAction:
    | "refresh"
    | "open_droid_setup"
    | "open_codex_setup"
    | "open_claude_setup"
    | "reset_canonical_state"
    | "retry_session"
    | "close_session";
}
~~~

Unknown codes/actions and native error or payload fields fail decoding. A
pre-registry database-open failure uses a separate app-startup diagnostic;
every session-scoped error identifies `providerInstanceId`. Messages are
sanitized and bounded.

There are no fallback providers. Missing Codex or Claude never routes to Droid.
Unsupported modes never degrade to auto. Failed resume never starts a new native
conversation under the same app session.

## Testing strategy

### Pure tests

- identity and target validation;
- provider-scoped models and strict capabilities;
- mode and autonomy translation;
- event normalization and deduplication keys;
- structured approvals and questions; and
- configuration and status redaction.

### Core deterministic tests

- immutable binding in application code and SQLite;
- raw provider ID collision isolation;
- stable app identity across native-session replacement;
- provisional create crash points;
- duplicate create and single-flight resume;
- per-session command serialization;
- close racing create, resume, send, steer, and interrupt;
- stale generation after provider awaits;
- wrong-instance and post-terminal event rejection;
- record-before-emit and persistence failure;
- stable, gap-free transcript paging;
- duplicate-event idempotency and conflicting-event rejection;
- bounded pre-activation buffering and bounded/cancellable search;
- restart state projection;
- generation-CAS resume cursor and native-binding updates;
- missing instance and missing native history recovery;
- failed-start exact retry and explicit canonical removal;
- pending interaction settlement; and
- children-before-parent, reverse-adapter, SQLite-last shutdown under one
  absolute deadline.

### Adapter tests

Droid retains its current regression suite.

Codex fixtures cover JSON framing, request correlation, unknown requests,
notification ordering, EOF, stderr pressure, mode parameters, text, reasoning,
tools, plans, diffs, usage, errors, missing resume history, overload,
interrupt-close races, and process termination.

Claude fixtures cover partial and snapshot deduplication, text, thinking, tools,
results, usage, errors, exact question keys, multi-select, all permission
decisions, plan review, prompt steering, cursor updates, unexpected query exit,
task-stop timeout, close-resume races, and shutdown.

### Renderer and bridge tests

- Droid is the draft default.
- Provider and model selection remain scoped together.
- Defaults survive switching between draft providers.
- Provider selection locks during creation.
- Active sessions ignore later default changes.
- Explicit next-turn settings updates preserve the provider and captured
  in-flight configuration.
- Unavailable and unsupported states are visible.
- Mission Control controls appear only for Droid.
- Catalog, status, and auth values never leak between providers.
- Refresh updates only the targeted snapshot.
- No secret enters renderer state.
- Malformed/oversized command frames and provider options are rejected before
  dispatch.
- Exact-key questions preserve scalar/array and multiselect behavior; approval,
  plan-review, cancellation, retry, and removal controls target only their
  canonical session/request.
- Simultaneous events target the correct session.
- Old renderer snapshots cannot resurrect sessions.

### Integration and smoke tests

- real bridge commands against deterministic adapters;
- three simultaneous fake-provider sessions;
- one provider crash while the others continue;
- sidecar restart and exact-provider lazy resume;
- packaged external executable discovery;
- packaged Claude SDK assets;
- authenticated Droid, Codex, and Claude smokes; and
- one authenticated simultaneous-provider desktop smoke.

## File and complexity budgets

Do not materially grow:

- sidecar/src/SessionManager.ts;
- sidecar/src/history.ts;
- sidecar/src/SessionLifecycle.ts;
- sidecar/src/ChildSessions.ts;
- sidecar/src/protocol.ts;
- src/hooks/useStore.tsx; or
- src/components/PromptInput.tsx.

New provider work belongs in focused provider and persistence modules. No new
production file may exceed 500 lines.

Split only by real ownership: transport, discovery, one live session,
normalization, interactions, mode translation, or settings state. Do not create
forwarding-only modules.

## Documentation and discoverability

The completed change updates README setup and product text, .env.example,
architecture and provider documentation, packaged-app troubleshooting,
settings help, recovery steps, release notes, third-party notices, and the T3
upstream source map.

The product message is:

> One DROIDEX interface. Droid by default. Choose Droid, Codex, or Claude for
> each new session and run them together.

Every provider shown in Settings either works or explains exactly how to make it
work. No control looks functional before its backend exists.

## Licensing, attribution, and upstream synchronization

T3 Code is MIT licensed. Copied or substantially derived material retains its
copyright and license notice.

The implementation adds:

- THIRD_PARTY_NOTICES.md;
- the T3 MIT license under third_party/t3-code/LICENSE;
- the pinned T3 repository SHA;
- a map from derived DROIDEX paths to T3 source paths; and
- short provenance headers on substantially ported files.

User-facing attribution may say that portions of the multi-provider runtime are
derived from T3 Code under the MIT License. It must not imply endorsement or use
T3 trademarks and assets as DROIDEX branding.

Official Codex-generated protocol material retains the full applicable
Apache-2.0 license, every required notice, and its exact upstream reference.

The Claude Agent SDK and harness are not T3 MIT code. Their licenses,
commercial terms, authentication paths, and redistribution rules are reviewed
independently before release. DROIDEX does not redistribute a provider CLI
without explicit approval.

Upstream synchronization is deliberate:

1. Fetch a candidate T3 SHA.
2. Diff only mapped provider files from the previous pin.
3. Review behavior and protocol changes.
4. Port relevant behavior and tests into DROIDEX idioms.
5. Update the pin and source map in the same commit.
6. Run adapter, provenance, license, and packaged-app gates.
7. Never merge T3 wholesale.

## Required validation

Broad validation is:

~~~bash
npm run format:check
npm run typecheck
npm run sidecar:typecheck
npm run electron:check
npm run test
npm --prefix sidecar run test
npm run docs:check
npm run quality:file-size
npm run quality:deadcode
npm run build
~~~

The implementation plan must verify every named script exists. A missing
quality script is added as an approved gate or replaced with the repository's
canonical equivalent; it is never reported as passing when absent.

Authenticated and signed packaged-app smokes remain explicit manual release
gates when CI cannot run them.

## Definition of done

The integration is complete only when:

- Droid remains default and existing Droid behavior passes;
- Codex and Claude are discoverable and configurable from Settings;
- supported create, resume, send, steer, interrupt, interaction, and close
  behavior works for all three;
- simultaneous sessions remain isolated;
- bindings and app identities survive restart;
- normalized transcripts restore from the canonical database;
- approvals, questions, plan review, and terminal paths settle correctly;
- capabilities are truthful in renderer and sidecar;
- unsupported behavior is disabled and rejected;
- crashes and shutdown cannot leak sessions or processes;
- settings and diagnostics expose no secrets;
- documentation and attribution are complete;
- deterministic validation passes;
- authenticated provider and simultaneous packaged smokes pass; and
- no loading, paging, or virtualization regression is introduced.

## Handoff

After this specification is committed and approved, use the writing-plans
workflow to create a dependency-ordered implementation plan with exact paths,
tests, commit boundaries, worktree ownership, and verification commands.

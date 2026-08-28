# Multi-Provider Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox syntax for tracking.

**Goal:** Give DROIDEX stable application-owned session identity and a fresh
canonical SQLite transcript store before adding another provider, while keeping
all current Droid product behavior and responsiveness.

**Architecture:** `DroidexDatabase` owns one connection, the exact schema, and
transactions. `SessionStore` owns summaries, private provider bindings,
children, and restart state. `TranscriptStore` alone owns turns, canonical
transcript events, ordering, paging, and search. `SessionTimeline` projects a
persisted canonical event to the renderer bridge only after the store assigns
its durable order. Existing `SessionRegistry`, `SessionLifecycle`, and
`SessionTimeline` consume those owners directly; there is no forwarding
`CanonicalHistory` facade.

**Tech Stack:** TypeScript, Node.js 22.23.1, `node:sqlite`, `node:test`, Zod.

## Global Constraints

- The approved design is
  `docs/superpowers/specs/2026-08-12-multi-provider-runtime-design.md`.
- Work only on the local `integration/multi-provider-v1` branch; never push.
- Use `$DROIDEX_USER_DATA_DIR/state/droidex.sqlite`, `user_version = 1`, and
  one exact current schema. A mismatched or nonempty version-0 file fails with
  its path and explicit move/remove recovery instructions.
- Never read, migrate, import, delete, or overwrite
  `~/.factory/droidex/session-index.sqlite` or `~/.factory/sessions` as
  DROIDEX history. Factory files remain provider-native resume material only.
- Native IDs stay sidecar-private. Every renderer command targets
  `appSessionId`, or `(parentAppSessionId, childSessionId)` for a child.
- `SessionSummary.configuration` is the only parent-session owner of provider
  selection, model/options, interaction mode, and autonomy. It has no
  top-level provider identity, model, reasoning, mode, or autonomy fields.
  Droid worker and validator settings live only under optional
  `droidMissionConfiguration`.
- Canonical transcript `eventId` is durable identity. Renderer
  `TranscriptEvent.id` is only its bridge projection, while SQLite
  `event_order` projects to renderer `seq`; none of those values is a native
  provider ID.
- Preserve the current history behavior: default recent window 400, explicit
  page ceiling 1,600, normal renderer older-page request 240, record before
  emit, streaming coalescing 40 ms / 64 KiB, chronological pages, and exact
  scroll anchoring. The 1,600 ceiling is an intentional existing invariant,
  not the 500-line source-file budget.
- Preserve the current search budgets exactly: at most the 150 most-recent
  session equivalents, 40,000,000 UTF-8 bytes, 25 session results, and three
  snippets per session. Search must remain cancellable and yield between
  bounded SQLite batches.
- A pre-activation provider event buffer is capped at 512 events and 1,048,576
  serialized bytes. Overflow fails the open, discards the buffer, settles
  callbacks, and closes the provisional native session.
- Keep all new production files below 500 lines. Do not materially grow the
  existing oversized orchestration files.
- Every task starts with a failing production-entry-point test, ends green, and
  lands as one focused local commit.

---

### Task 1: Add the exact canonical database schema

**Files:**

- Create: `sidecar/src/persistence/DroidexDatabase.ts`
- Create: `sidecar/src/persistence/DroidexDatabase.test.ts`
- Modify: `sidecar/src/droidexPaths.ts`

**Contract:**

```ts
export const DROIDEX_SCHEMA_VERSION = 1;
export function droidexDatabasePath(): string;

export class DroidexDatabase {
  constructor(path?: string);
  transaction<T>(operation: () => T): T;
  prepare(sql: string): StatementSync;
  close(): void;
}
```

The v1 schema contains only cohesive, immediately owned tables:

- `sessions`: `app_session_id` primary key; unique durable `client_ref` for
  create-command deduplication; immutable
  `provider_driver_kind` and `provider_instance_id`; nullable private
  `provider_session_id`; JSON replacement IDs and resume state; generation;
  summary JSON; lifecycle status; sanitized failure code/message/closed recovery
  action; hidden flag; created/updated timestamps. A partial unique index scopes
  non-null native IDs by `(provider_instance_id, provider_session_id)`.
- `child_sessions`: composite key
  `(parent_app_session_id, child_session_id)`, private native binding fields,
  summary JSON, timestamps, and parent foreign key.
- `turns`: DROIDEX `turn_id` primary key, parent app ID, target kind and
  optional child ID, runtime generation, lifecycle status, optional private
  provider turn ID, and timestamps.
- `transcript_events`: autoincrement `event_order`, unique canonical
  `event_id`, canonical target, optional turn ID, generation, provider kind and
  instance, optional private native correlation IDs, complete `payload_json`,
  derived `search_text`, and creation time.

Freeze these exact v1 identifiers and storage types before implementation:

```text
sessions(
  app_session_id TEXT PRIMARY KEY,
  client_ref TEXT NOT NULL,
  provider_driver_kind TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  previous_provider_session_ids_json TEXT NOT NULL,
  resume_state_json TEXT,
  runtime_generation INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  failure_code TEXT,
  failure_message TEXT,
  failure_recovery_action TEXT,
  hidden INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

child_sessions(
  parent_app_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  provider_driver_kind TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  previous_provider_session_ids_json TEXT NOT NULL,
  resume_state_json TEXT,
  runtime_generation INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(parent_app_session_id, child_session_id)
)

turns(
  turn_id TEXT PRIMARY KEY,
  parent_app_session_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  child_session_id TEXT,
  runtime_generation INTEGER NOT NULL,
  lifecycle_status TEXT NOT NULL,
  provider_turn_id TEXT,
  started_at INTEGER NOT NULL,
  settled_at INTEGER
)

transcript_events(
  event_order INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  parent_app_session_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  child_session_id TEXT,
  turn_id TEXT,
  runtime_generation INTEGER NOT NULL,
  provider_driver_kind TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  provider_turn_id TEXT,
  provider_item_id TEXT,
  payload_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

All IDs are nonempty and bounded by the bridge contract. JSON columns require
`json_valid`; replacement IDs require a JSON array; generations and timestamps
are nonnegative; `hidden` is 0/1; driver/instance pairs, lifecycle values,
failure codes/actions, and session/child target shapes use closed checks. A
failed session has all three failure fields and any other state has none. A
settled turn has `settled_at`; a pending/running turn does not. Timestamps are
Unix milliseconds.

Named objects are exactly:

- indexes `sessions_client_ref_unique`, `sessions_native_binding_unique`,
  `sessions_activity`, `child_sessions_native_binding_unique`,
  `child_sessions_activity`, `turns_target_activity`,
  `transcript_events_session_page`, and `transcript_events_child_page`;
- triggers `sessions_immutable_identity` and
  `child_sessions_immutable_identity`; and
- foreign keys from every child/turn/event to its parent with `ON DELETE
  CASCADE`, plus composite child-target and optional turn references.

SQLite's automatic primary-key/unique indexes and `sqlite_sequence` are allowed
implementation objects; no other application table, index, or trigger is. Use
`busy_timeout = 5000`. Exact schema validation compares table columns (name,
type, nullability, primary-key position), foreign keys, named index columns and
predicates, trigger SQL, and `user_version`, not only object presence.

The schema includes checks for the closed v1 driver/instance pairs, valid
target shapes and session/turn lifecycle values; foreign keys; immutable-binding
triggers; and indexes for top-level and child transcript paging. The
`transcript_events` columns are the authoritative canonical event envelope;
`payload_json` contains only the strict canonical transcript payload, never a
renderer event or raw provider object. Do not add unused settings/catalog/
feature tables: current feature metadata remains part of the strict session
summary JSON until a real independent owner is introduced.

- [ ] **Step 1: Write failing path/schema/recovery tests**

Test the exact path, tables, columns, indexes, triggers, `user_version`, WAL,
foreign keys, idempotent close, rollback, invalid driver/instance pairs,
invalid target shapes, and immutability triggers. Prove two provider instances
may each retain private native ID `native-1`. Create a nonempty version-0 and a
wrong-version database and assert the diagnostic contains the exact path and
`move or remove this file, then restart DROIDEX`. Snapshot an old Factory file
byte-for-byte and prove opening the canonical database does not touch it.

- [ ] **Step 2: Confirm the test fails because the owner is absent**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/persistence/DroidexDatabase.test.ts
```

- [ ] **Step 3: Implement the minimal owner and exact schema validation**

Use `mkdirSync(dirname(path), { recursive: true })`, `DatabaseSync`, WAL,
`foreign_keys = ON`, a bounded `busy_timeout`, and explicit `BEGIN IMMEDIATE` /
`COMMIT` / `ROLLBACK`. Validate exact tables, columns, indexes, triggers, and
version on every open. Do not add a migration branch or silent rebuild.

- [ ] **Step 4: Run focused validation and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/persistence/DroidexDatabase.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/droidexPaths.ts sidecar/src/persistence/DroidexDatabase.ts sidecar/src/persistence/DroidexDatabase.test.ts
rtk git commit -m "feat(persistence): add canonical DROIDEX database"
```

### Task 2: Hard-cut the current session contract to one canonical configuration

**Files:**

- Create: `sidecar/src/providers/providerIdentity.ts`
- Create: `sidecar/src/providers/providerIdentity.test.ts`
- Create: `sidecar/src/providers/providerErrors.ts`
- Create: `sidecar/src/providers/providerErrors.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `sidecar/src/sessionHelpers.ts`
- Modify: `sidecar/src/sessionHelpers.test.ts`
- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionManager.settings.test.ts`
- Modify: `sidecar/src/SessionCompaction.ts`
- Modify: `sidecar/src/SessionCompaction.test.ts`
- Modify: `sidecar/src/SessionContext.ts`
- Modify: `sidecar/src/SessionContext.test.ts`
- Modify: `sidecar/src/MissionControlPolicy.ts`
- Modify: `sidecar/src/MissionControlPolicy.test.ts`
- Modify: `sidecar/src/history.ts`
- Modify: `sidecar/src/testing/historyCharacterizationSupport.ts`
- Modify: `sidecar/src/testing/sessionManagerTestContext.ts`
- Modify: `src/hooks/useStore.tsx`
- Modify: `src/hooks/useStore.test.ts`
- Modify: `src/components/PromptInput.tsx`
- Modify: `src/components/PromptInput.test.ts`
- Modify: `src/components/ModelSelectorPopover.tsx`
- Modify: `src/components/ModelSelectorPopover.test.ts`
- Modify: `src/components/RightPanel.tsx`
- Modify: `src/components/RightPanel.test.ts`
- Modify: `src/lib/sessionSnapshot.ts`
- Modify: `src/lib/sessionSnapshot.test.ts`

**Contract:**

```ts
export type ProviderDriverKind = 'droid' | 'codex' | 'claude';
export type ProviderInstanceId = 'droid' | 'codex' | 'claude';

export type ProviderErrorCode =
  | 'invalid_provider_configuration'
  | 'missing_executable'
  | 'unauthenticated_provider'
  | 'unsupported_provider_version'
  | 'unavailable_provider_instance'
  | 'unsupported_capability'
  | 'native_session_start_failed'
  | 'incompatible_provider_protocol'
  | 'provider_process_exited'
  | 'interaction_cancelled'
  | 'stale_provider_operation'
  | 'canonical_persistence_unavailable';

export type ProviderRecoveryAction =
  | 'refresh'
  | 'open_droid_setup'
  | 'open_codex_setup'
  | 'open_claude_setup'
  | 'reset_canonical_state'
  | 'retry_session'
  | 'close_session';

export interface ProviderError {
  code: ProviderErrorCode;
  providerInstanceId: ProviderInstanceId;
  message: string;
  recoveryAction: ProviderRecoveryAction;
}

export type SessionTarget =
  | { kind: 'session'; appSessionId: string }
  | {
      kind: 'child';
      parentAppSessionId: string;
      childSessionId: string;
    };

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

`providerIdentity.ts` owns driver/instance/target/selection types;
`providerErrors.ts` owns the error-code, recovery-action, and structured-error
types plus strict decoders. Both protocol mirrors reuse the same exact closed
values rather than accepting arbitrary strings.

`SessionSummary` gains exactly one required `configuration` plus optional
`droidMissionConfiguration`. Delete top-level `providerDriverKind`,
`providerInstanceId`, `modelId`, `reasoningEffort`, `interactionMode`,
`autonomy`, and the four generic worker/validator fields. Droid reasoning is
`configuration.providerSelection.options.reasoningEffort`.
`droidMissionConfiguration` is valid only when the registry resolves the
nested instance to the Droid driver and the mode is `agi`. Child summaries
remain Droid-only in this checkpoint and keep their existing model fields.

`session.create` requires one complete `configuration` and optional
`droidMissionConfiguration`; it deletes every parallel provider/model/mode/
autonomy and worker/validator input. `session.updateSettings` is exactly
`{ type: 'session.updateSettings'; appSessionId: string; configuration:
SessionConfiguration }`: it rejects an instance change, validates capabilities,
captures the replacement, and applies it to the next accepted turn. An
in-flight turn keeps its captured configuration; current Droid native settings
are applied immediately before that next turn, never eagerly during the update
command. Current renderer producers and consumers move atomically to these
shapes so no commit contains two configuration owners. For this Droid-only
checkpoint every production configuration selects `droid`; no decoder supplies
a missing default. The existing native-ID fields are removed atomically in
Task 4 when their private owner lands, rather than mirrored into a second owner.

- [ ] **Step 1: Add failing provider-identity and protocol-mirror tests**

Prove only the three exact v1 instance/driver pairs validate, equal model IDs
remain different when instance IDs differ, and a summary without a complete
configuration is rejected rather than coerced to Droid. Assert top-level
provider kind/instance, model/reasoning, mode/autonomy, and generic worker/
validator fields are absent from both protocol mirrors. Reject Droid Mission
configuration on non-Droid or non-AGI summaries. Prove a settings update cannot
change the nested instance, cannot mutate an in-flight turn, and is translated
exactly once immediately before the next accepted Droid turn. Cover every one
of the 12 error codes, only the seven recovery actions, and rejection of unknown
codes, actions, raw native error objects, and payload fields.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/providerIdentity.test.ts sidecar/src/providers/providerErrors.test.ts sidecar/src/sessionHelpers.test.ts src/lib/sessionSnapshot.test.ts
```

- [ ] **Step 3: Implement the required fields and update all Droid producers**

Keep the union and validation in `providerIdentity.ts`; mirror only bridge
types. Update every current Droid producer and renderer consumer in the file
list to use the single selection object. The current Factory history reader
temporarily projects its current native record into the new canonical
configuration so this intermediate commit builds. This narrow transition
exists only because Task 9 has not yet removed the Factory history source;
Task 9 deletes the Factory reader and this projection in full. The branch must
not ship between Tasks 2 and 9, and no second summary decoder or persisted
compatibility shape may be introduced.

- [ ] **Step 4: Validate and commit exact touched paths**

```bash
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run test
rtk mise exec node@22 -- npm --prefix sidecar run test
rtk git add sidecar/src/providers/providerIdentity.ts sidecar/src/providers/providerIdentity.test.ts sidecar/src/providers/providerErrors.ts sidecar/src/providers/providerErrors.test.ts sidecar/src/protocol.ts sidecar/src/sessionHelpers.ts sidecar/src/sessionHelpers.test.ts sidecar/src/SessionLifecycle.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionManager.settings.test.ts sidecar/src/SessionCompaction.ts sidecar/src/SessionCompaction.test.ts sidecar/src/SessionContext.ts sidecar/src/SessionContext.test.ts sidecar/src/MissionControlPolicy.ts sidecar/src/MissionControlPolicy.test.ts sidecar/src/history.ts sidecar/src/testing/historyCharacterizationSupport.ts sidecar/src/testing/sessionManagerTestContext.ts src/types/bridge.ts src/hooks/useStore.tsx src/hooks/useStore.test.ts src/components/PromptInput.tsx src/components/PromptInput.test.ts src/components/ModelSelectorPopover.tsx src/components/ModelSelectorPopover.test.ts src/components/RightPanel.tsx src/components/RightPanel.test.ts src/lib/sessionSnapshot.ts src/lib/sessionSnapshot.test.ts
rtk git commit -m "feat(sessions): require provider-scoped identity"
```

### Task 3: Validate every runtime bridge command before dispatch

**Files:**

- Create: `sidecar/src/bridgeCommandParser.ts`
- Create: `sidecar/src/bridgeCommandParser.test.ts`
- Create: `sidecar/src/bridgeSchemas/commandBounds.ts`
- Create: `sidecar/src/bridgeSchemas/sessionCommands.ts`
- Create: `sidecar/src/bridgeSchemas/browserCommands.ts`
- Create: `sidecar/src/bridgeSchemas/mcpCommands.ts`
- Create: `sidecar/src/bridgeSchemas/desktopCommands.ts`
- Create: `sidecar/src/index.bridge.test.ts`
- Modify: `sidecar/src/index.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `sidecar/src/mcpProtocol.ts`

**Contract:**

```ts
export const MAX_BRIDGE_FRAME_BYTES = 1_048_576;

export type BridgeCommandParseResult =
  | { ok: true; command: ClientCommand }
  | {
      ok: false;
      code: 'invalid_bridge_frame' | 'bridge_frame_too_large';
      message: string;
      closeCode?: 1003 | 1009;
    };

export function parseBridgeCommand(raw: RawData, isBinary: boolean): BridgeCommandParseResult;
```

`bridgeCommandParser.ts` only composes four strict Zod command-family unions:
session/provider, browser, MCP, and desktop/runtime. Each owning schema file
defines every nested strict object in its family; `mcpCommands.ts` imports
closed MCP values from `mcpProtocol.ts` rather than duplicating permissive
records. Stop for architecture review before any production schema file crosses
500 lines; split only another cohesive protocol family, never compress schemas
or build a generic recursive validator to evade the limit.

`commandBounds.ts` exports exact shared caps: IDs/model IDs 256 UTF-8 bytes,
titles/labels/option keys 1,024 bytes, paths/URLs 16,384 bytes, free-form prompt
or instruction strings 262,144 bytes, at most 64 files/skills/browser references
or structured questions, at most 64 provider option entries, and 65,536 encoded
bytes for the complete `SessionConfiguration`. Command-family schemas apply
smaller existing product limits when one already exists. `index.ts` passes the
WebSocket `isBinary` bit, computes the byte count before UTF-8/JSON decoding,
and dispatches only the validated command. Text frames above exactly 1,048,576
bytes close with 1009; binary or invalid UTF-8 closes with 1003; well-sized
invalid JSON or schema input receives one sanitized `invalid_bridge_frame`
error and never reaches `SessionManager.handle`. Unknown keys and unknown
command discriminants are rejected. Every later task that changes
`ClientCommand` must change its owning schema and exhaustive fixture in the
same commit.

Configure the WebSocket server's `maxPayload` to the same frame ceiling so the
transport rejects oversized fragmented messages before materializing an
unbounded buffer. The parser still checks the reassembled raw byte length so
direct callers and boundary tests enforce the identical rule.

- [ ] **Step 1: Write failing parser and real WebSocket boundary tests**

Cover every current command discriminant with one valid fixture. Negatives
cover invalid JSON, null/array roots, unknown types, missing and extra fields,
invalid target/enum/nested-union values, unknown provider option value shapes,
each command-specific string/array/configuration boundary, invalid UTF-8,
binary frames, one byte below/at/above the frame cap, and fragmented raw data
whose combined size exceeds the cap. Assert malformed or oversized provider
selection never invokes an adapter, all rejected input never calls the manager,
and diagnostics echo no untrusted payload.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/bridgeCommandParser.test.ts sidecar/src/index.bridge.test.ts
```

- [ ] **Step 3: Implement the strict parser and route `index.ts` through it**

Use fatal UTF-8 decoding and Zod `.strict()` objects. Keep the schema mirror
exhaustive with a compile-time map keyed by `ClientCommand['type']`; do not cast
`JSON.parse` to `ClientCommand`, retain permissive fallbacks, or log the frame.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/bridgeCommandParser.test.ts sidecar/src/index.bridge.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/bridgeCommandParser.ts sidecar/src/bridgeCommandParser.test.ts sidecar/src/bridgeSchemas/commandBounds.ts sidecar/src/bridgeSchemas/sessionCommands.ts sidecar/src/bridgeSchemas/browserCommands.ts sidecar/src/bridgeSchemas/mcpCommands.ts sidecar/src/bridgeSchemas/desktopCommands.ts sidecar/src/index.bridge.test.ts sidecar/src/index.ts sidecar/src/protocol.ts sidecar/src/mcpProtocol.ts
rtk git commit -m "fix(bridge): validate runtime command frames"
```

### Task 4: Make SessionStore the sole owner of private bindings and summaries

**Files:**

- Create: `sidecar/src/persistence/SessionStore.ts`
- Create: `sidecar/src/persistence/SessionStore.test.ts`
- Modify: `sidecar/src/SessionRegistry.ts`
- Modify: `sidecar/src/SessionRegistry.test.ts`
- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/sessionHelpers.ts`
- Modify: `sidecar/src/sessionCompactionExecution.ts`
- Modify: `sidecar/src/SessionContext.ts`
- Modify: `sidecar/src/SessionCompaction.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionTimeline.ts`
- Modify: `sidecar/src/sessionMarkdown.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `sidecar/src/mcpProtocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/types/mcp.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/browserSessionIdentity.ts`
- Modify: `src/components/SessionContextMenu.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/PromptInput.tsx`
- Modify: `src/hooks/useStore.tsx`
- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionCompaction.test.ts`
- Modify: `sidecar/src/SessionContext.test.ts`
- Modify: `sidecar/src/sessionMarkdown.test.ts`
- Modify: `src/components/SessionContextMenu.test.ts`
- Modify: `src/lib/browserSessionIdentity.test.ts`
- Modify: `src/lib/commands.test.ts`

**Private contract:**

```ts
export interface ProviderBinding {
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  providerSessionId?: string;
  previousProviderSessionIds: string[];
  resumeState?: unknown;
  runtimeGeneration: number;
}

export interface StoredSession {
  summary: SessionSummary;
  binding: ProviderBinding;
  lifecycleStatus: 'initializing' | 'running' | 'paused' | 'completed' | 'failed';
  failure?: ProviderError;
  hidden: boolean;
}
```

`SessionStore` implements `createProvisional`, `findByClientRef`, `markStarted`,
`markFailed`, `get`, `list`, `updateSummary`, compare-and-swap
`bindInitialProviderRuntime`, `updateResumeState`, and
`replaceProviderRuntime`, plus `setHidden` and child upsert/read. It does not
own turns and has no `close()`; `TranscriptStore` owns turns and
`DroidexDatabase` alone closes SQLite. Each method validates strict JSON and
owns its SQL; no one-line repository facade wraps it.

`updateResumeState(expectedGeneration, resumeState)` updates opaque state only
when the generation matches and does not increment it.
`replaceProviderRuntime(expectedGeneration, providerSessionId, resumeState)`
atomically appends the previous native ID, installs the replacement, and
increments/returns the generation. Neither operation may change provider kind,
instance, app ID, or primary selection. These are the only durable operations
later exposed to a provider binding-update callback; adapters never receive a
store reference.

`markFailed` accepts only `ProviderError`, requires its instance to match the
immutable session binding, and persists the closed code, sanitized message, and
closed recovery action. Rehydration rejects an unknown code/action or mismatch;
it never exposes a native error object.

`RegisteredSession` and `LiveSession` carry a private `binding` beside the
public `summary`. `SessionRegistry` accepts only app IDs and persists through
`SessionStore`; delete `providerAliases`, native-ID scans, and native-ID patch
fields. Remove `providerSessionId` and `compactedFromProviderSessionIds` from
both public protocol mirrors in this same commit. Compaction and context read
the binding from the live/stored session. Markdown export contains canonical
metadata and never prints a provider resume command or native ID.

Delete native-ID bridge routing in the same hard cut: `history.list`,
`history.page`, `SessionHistoryEntry`, native-ID catalog inputs, native-ID error
fields, Factory web/resume actions in `SessionContextMenu`, and renderer skill
catalog state keyed by native session. Catalog operations target an
`appSessionId` for a live session or a `providerInstanceId` for discovery.
Browser identity remains `appSessionId` only. Update `mcpProtocol` only where a
native ID is currently exposed across the bridge; sidecar-private Droid MCP
correlation may retain it internally.

- [ ] **Step 1: Write failing store, immutability, collision, and registry tests**

Cover the exact `summary_json` key set, strict summary/resume JSON, duplicate app ID, durable duplicate
`clientRef`, reverse activity order, successful and stale-generation binding
CAS, same-generation resume-state update, native replacement generation and
previous-ID append, binding immutability in SQL and application code, two
instances using `native-1`, app-ID-only lookup/update/unregister, and absence
of native IDs in serialized `SessionSummary` and Markdown. Include
strict structured-failure round-trip plus unknown-code/action,
wrong-provider-instance, and native-payload rejection.

- [ ] **Step 2: Run the failing focused tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/persistence/SessionStore.test.ts sidecar/src/SessionRegistry.test.ts sidecar/src/sessionMarkdown.test.ts
```

- [ ] **Step 3: Implement the store and one hard identity cut**

Decode persisted data strictly; a corrupt canonical row reports the database
path and reset recovery. `summary_json` has exactly the mutable public summary
projection and omits column-owned `appSessionId`, lifecycle/failure state, and
created/updated timestamps. It contains one complete `configuration`, whose
nested instance must equal the authoritative provider-instance column;
provider driver remains private in the binding column and is resolved through
the registry rather than added to `SessionSummary`. `SessionStore` reconstructs
the omitted public fields and rejects unknown JSON keys, missing required keys,
a mismatched configuration instance, or an update attempting to change
identity. Keep opaque resume state opaque. Replace every
top-level `summary.providerSessionId` access in production with the private
binding owner before deleting the public fields. Native child correlation may
remain only in the private persisted child record.

- [ ] **Step 4: Run focused and compile gates, then commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/persistence/SessionStore.test.ts sidecar/src/SessionRegistry.test.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionCompaction.test.ts sidecar/src/SessionContext.test.ts sidecar/src/sessionMarkdown.test.ts src/components/SessionContextMenu.test.ts src/lib/browserSessionIdentity.test.ts src/lib/commands.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/persistence/SessionStore.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/SessionRegistry.ts sidecar/src/SessionRegistry.test.ts sidecar/src/SessionLifecycle.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/sessionHelpers.ts sidecar/src/sessionCompactionExecution.ts sidecar/src/SessionContext.ts sidecar/src/SessionContext.test.ts sidecar/src/SessionCompaction.ts sidecar/src/SessionCompaction.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionTimeline.ts sidecar/src/sessionMarkdown.ts sidecar/src/sessionMarkdown.test.ts sidecar/src/protocol.ts sidecar/src/mcpProtocol.ts src/types/bridge.ts src/types/mcp.ts src/lib/commands.ts src/lib/commands.test.ts src/lib/browserSessionIdentity.ts src/lib/browserSessionIdentity.test.ts src/components/SessionContextMenu.tsx src/components/SessionContextMenu.test.ts src/components/Sidebar.tsx src/components/PromptInput.tsx src/hooks/useStore.tsx
rtk git commit -m "refactor(sessions): privatize provider runtime identity"
```

### Task 5: Define the canonical event envelope, then persist turns, pages, and search

**Files:**

- Create: `sidecar/src/sessionEvents.ts`
- Create: `sidecar/src/sessionEvents.test.ts`
- Create: `sidecar/src/persistence/TranscriptStore.ts`
- Create: `sidecar/src/persistence/TranscriptStore.test.ts`
- Modify: `sidecar/src/SessionTimeline.ts`
- Modify: `sidecar/src/SessionTimeline.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`

**Contract:**

```ts
export interface TranscriptPage {
  events: PersistedCanonicalEvent[];
  olderCursor?: string;
}

export interface CanonicalTranscriptPayload {
  role: SessionRole;
  kind: TranscriptEvent['kind'];
  endAt?: number;
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolUseId?: string;
  isError?: boolean;
  removedCount?: number;
  author?: 'user';
  skills?: string[];
  files?: string[];
  browserRefs?: BrowserTranscriptReference[];
  steered?: boolean;
  compactType?: 'auto' | 'manual';
}

export type CanonicalTurnSettlement =
  | { status: 'completed' }
  | { status: 'failed'; error: ProviderError }
  | { status: 'interrupted' | 'cancelled' };

export type CanonicalEventPayload =
  | { type: 'session.lifecycle'; status: 'started' | 'resumed' | 'closed' | 'failed' }
  | { type: 'turn.started' }
  | { type: 'transcript'; transcript: CanonicalTranscriptPayload }
  | { type: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number }
  | { type: 'approval.lifecycle'; requestId: string; status: 'requested' | 'settled' }
  | { type: 'question.lifecycle'; requestId: string; status: 'requested' | 'settled' }
  | { type: 'plan_review.lifecycle'; requestId: string; status: 'requested' | 'settled' }
  | { type: 'session.effect'; effect: CanonicalSessionEffect }
  | {
      type: 'binding.updated';
      resumeState: unknown;
      replacementProviderSessionId?: string;
    }
  | { type: 'turn.settled'; settlement: CanonicalTurnSettlement }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: ProviderError };

export interface CanonicalEvent {
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
  payload: CanonicalEventPayload;
}

export interface PersistedCanonicalEvent extends CanonicalEvent {
  seq: number;
}

export function projectTranscriptEvent(event: PersistedCanonicalEvent): TranscriptEvent | undefined;

export interface PersistedTurnStart {
  turnId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  startedAt: string;
}

export interface PersistedTurnSettlement {
  runtimeGeneration: number;
  status: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  settledAt: string;
  providerTurnId?: string;
}

export class TranscriptStore {
  beginTurn(input: PersistedTurnStart): void;
  settleTurn(turnId: string, settlement: PersistedTurnSettlement): void;
  append(event: CanonicalEvent): PersistedCanonicalEvent;
  appendMany(events: readonly CanonicalEvent[]): PersistedCanonicalEvent[];
  page(input: SessionTarget & { before?: string; limit?: number }): TranscriptPage;
  search(query: string, isStale?: () => boolean): Promise<SessionSearchResult[]>;
}
```

`CanonicalSessionEffect` is the closed union for context, compaction,
observational-task, and child-upsert facts already named in the approved design;
it is defined in `sessionEvents.ts`, not as an open record. Implement and test
the entire `CanonicalEvent` decoder and projector before writing
`TranscriptStore`; no temporary transcript-only envelope is permitted. The
store persists the envelope in authoritative columns and the strict
discriminated payload in `payload_json`. On the bridge,
`TranscriptEvent.id = eventId`, `seq = event_order`, `ts = createdAt`, and
target maps to app/source identity; provider/native correlation never crosses
the bridge. Non-transcript payloads drive their owning side effects and do not
project to a fake renderer transcript. No persistence API accepts the renderer
`TranscriptEvent` shape.

An exact replay of an existing `eventId` returns the original row and allocates
no order. Reusing an `eventId` with any different envelope or payload field is
a deterministic collision error: the transaction rolls back, no event emits,
and the existing row is unchanged. A cursor is the decimal `event_order` of the
oldest returned event; the next query uses strict `< cursor`. Invalid cursors
fail explicitly. Results are chronological even when timestamps collide. The
default is 400 and the explicit limit clamps to 1..1,600.

Search considers at most the 150 most-recent sessions and charges at most
40,000,000 UTF-8 bytes of searchable user/assistant text. It returns at most 25
sessions and three newest snippets per session; tool, thinking, and internal
text stays excluded. Read SQLite in bounded event-order batches, checking
`isStale` before and after each batch and yielding through an injected
`yieldToEventLoop` between batches. Never call one synchronous `.all()` that
can materialize the whole byte budget.

- [ ] **Step 1: Write failing ordering, paging, payload, and search tests**

First prove the exact canonical envelope decoder and renderer projection,
including `eventId`/`id`, `event_order`/`seq`, target mapping, and native-field
redaction. Then cover interleaved sessions/children, equal timestamps, exact
cursor boundaries, exact duplicate replay versus conflicting duplicate ID,
malformed cursor/payload, tool payload round-trip, 400 default, 1,600 clamp,
unique turn IDs, strict start/settlement validation, legal and illegal
begin/settle state transitions, generation matching, the 150-session/
40,000,000-byte/25-result/three-snippet budgets, deterministic yields, and
stale-search cancellation before and after a batch.

- [ ] **Step 2: Run the failing store test**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/sessionEvents.test.ts sidecar/src/persistence/TranscriptStore.test.ts
```

- [ ] **Step 3: Implement and make SessionTimeline depend directly on it**

`recordAndEmit` appends the canonical envelope, then projects and emits the
returned persisted row. A failed append or collision preserves the existing
reported persistence-error behavior and emits no undurable event. Keep 40 ms /
64 KiB coalescing unchanged. `TranscriptStore`, not `SessionStore`, performs
every turn insert/read/settlement.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/sessionEvents.test.ts sidecar/src/persistence/TranscriptStore.test.ts sidecar/src/SessionTimeline.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/sessionEvents.ts sidecar/src/sessionEvents.test.ts sidecar/src/persistence/TranscriptStore.ts sidecar/src/persistence/TranscriptStore.test.ts sidecar/src/SessionTimeline.ts sidecar/src/SessionTimeline.test.ts sidecar/src/protocol.ts src/types/bridge.ts
rtk git commit -m "feat(persistence): store canonical transcript pages"
```

### Task 6: Allocate and persist app session and turn identity before Droid work

**Files:**

- Create: `sidecar/src/sessionPreActivationBuffer.ts`
- Create: `sidecar/src/sessionPreActivationBuffer.test.ts`
- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/sessionHelpers.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionEventFlow.test.ts`
- Modify: `sidecar/src/persistence/SessionStore.ts`
- Modify: `sidecar/src/persistence/SessionStore.test.ts`
- Modify: `sidecar/src/persistence/TranscriptStore.ts`
- Modify: `sidecar/src/persistence/TranscriptStore.test.ts`

**Ordering:**

1. Resolve durable `clientRef` deduplication, then allocate `appSessionId` and
   first `turnId` with injected generators.
2. Build an `initializing` Droid summary and set interaction refs immediately.
3. Wrap `SessionStore.createProvisional` and `TranscriptStore.beginTurn` in one
   `DroidexDatabase.transaction`.
4. Construct the bounded pre-activation buffer, register every event and
   interaction handler against it, then resolve defaults and start local MCP
   resources.
5. Create the native Droid session with those handlers already installed.
6. Compare-and-swap the expected generation while persisting native ID, opaque
   resume state, and the next generation.
7. Register the live session, activate/flush the buffer in order, publish it,
   and start the accepted turn.

On native-start failure, close provisional resources, transactionally mark that
same canonical session/turn failed, and append one sanitized startup diagnostic.
A database failure before step 4 makes no native call. A database failure after
step 5 closes the native session and reports canonical persistence recovery. A
pre-activation buffer that would exceed 512 events or 1,048,576 serialized
bytes follows the same failed-open path: it accepts no later event, discards all
buffered transcript output, settles pending callbacks, and closes the
provisional native session. A failed open is visible and removable; it is never
automatically deleted or rebound.

- [ ] **Step 1: Add deterministic crash-point and ordering tests**

Inject IDs and failure at every numbered boundary. Assert the canonical app ID
differs from the fake native ID, the ref is usable during native callbacks, no
duplicate session/turn appears, no transcript escapes before durable binding,
`session.created` is emitted only after step 6, exact buffer-boundary values
activate, count/byte overflow fails and closes, close-before-activation discards
the buffer, and replaying the same `clientRef` after restart never starts a
second native session.

- [ ] **Step 2: Run the failing lifecycle tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/sessionPreActivationBuffer.test.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionEventFlow.test.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/persistence/TranscriptStore.test.ts
```

- [ ] **Step 3: Implement ordering with captured identity/generation checks**

Use `randomUUID` only behind injected `nextAppSessionId` / `nextTurnId`
functions. Revalidate shutdown, current binding, and generation after every
provider or persistence await. Cleanup and settlement are idempotent.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/sessionPreActivationBuffer.test.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionEventFlow.test.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/persistence/TranscriptStore.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/sessionPreActivationBuffer.ts sidecar/src/sessionPreActivationBuffer.test.ts sidecar/src/SessionLifecycle.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/sessionHelpers.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionEventFlow.test.ts sidecar/src/persistence/SessionStore.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/persistence/TranscriptStore.ts sidecar/src/persistence/TranscriptStore.test.ts
rtk git commit -m "feat(sessions): persist identity before provider startup"
```

### Task 7: Serve list, restore, search, export, and resume from canonical state

**Files:**

- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/SessionTimeline.ts`
- Modify: `sidecar/src/SessionManager.sessionListServing.test.ts`
- Modify: `sidecar/src/SessionManager.sessionSearch.test.ts`
- Modify: `sidecar/src/SessionManager.historyAndChildren.test.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`

The native-ID bridge commands were removed in Task 3. Confirm they remain
absent while `sessions.list`, `session.loadHistory`, search, and Markdown export
move to the real stores directly. Provider status/catalog routes use
provider-instance or app identity, never native IDs.

Resume resolves an exact stored `appSessionId` and binding. Missing rows,
instances, native history, malformed resume state, and native rejection persist
a visible failed state and recovery diagnostic. Delete the current fallback
that treats the requested app ID as a provider ID; never resume as a new empty
conversation.

- [ ] **Step 1: Add failing production-path and public-boundary tests**

Prove two private `native-1` IDs never cross-route; every public attempt to use
`native-1` as an app ID fails; list/search/history/export read SQLite only; and
resume failures preserve the original app identity without native creation.

- [ ] **Step 2: Run the failing focused tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionManager.sessionListServing.test.ts sidecar/src/SessionManager.sessionSearch.test.ts sidecar/src/SessionManager.historyAndChildren.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts
```

- [ ] **Step 3: Cut all read paths and resume to the canonical stores**

Keep `SessionManager` as composition/dispatch only. Put SQL and validation in
the owning stores, not a new history facade.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionManager.sessionListServing.test.ts sidecar/src/SessionManager.sessionSearch.test.ts sidecar/src/SessionManager.historyAndChildren.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionTimeline.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/SessionManager.ts sidecar/src/SessionLifecycle.ts sidecar/src/SessionTimeline.ts sidecar/src/SessionManager.sessionListServing.test.ts sidecar/src/SessionManager.sessionSearch.test.ts sidecar/src/SessionManager.historyAndChildren.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/protocol.ts src/types/bridge.ts src/lib/commands.ts
rtk git commit -m "refactor(history): serve canonical DROIDEX state"
```

### Task 8: Add explicit failed-start retry and canonical removal

**Files:**

- Modify: `sidecar/src/persistence/SessionStore.ts`
- Modify: `sidecar/src/persistence/SessionStore.test.ts`
- Modify: `sidecar/src/persistence/TranscriptStore.ts`
- Modify: `sidecar/src/persistence/TranscriptStore.test.ts`
- Modify: `sidecar/src/SessionLifecycle.ts`
- Modify: `sidecar/src/SessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/SessionManager.sessionLifecycle.test.ts`
- Modify: `sidecar/src/SessionRegistry.ts`
- Modify: `sidecar/src/SessionRegistry.test.ts`
- Modify: `sidecar/src/bridgeSchemas/sessionCommands.ts`
- Modify: `sidecar/src/bridgeCommandParser.test.ts`
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/lib/commands.test.ts`

Add only these commands and result event:

```ts
type FailedSessionCommand =
  | { type: 'session.retryStart'; appSessionId: string }
  | { type: 'session.removeFailed'; appSessionId: string };

type FailedSessionEvent =
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.removed'; appSessionId: string };
```

`session.retryStart` accepts only a persisted failed session that is absent
from the live registry. It preserves `appSessionId`, immutable provider
instance, exact stored configuration, and every existing canonical transcript
row. Allocate a new `turnId`; transactionally compare-and-swap failed →
initializing, clear the prior failure, increment `runtimeGeneration`, and begin
the turn. If no native binding was ever durable, retry native create. If a
binding exists, retry exact native resume. It never changes providers, falls
back from resume to create, reuses the failed turn, or invents new defaults.
Success follows the ordinary durable-bind/register/activate/start ordering and
emits `session.updated`; another failure settles the new turn and restores one
visible structured failure on the same app session.

`session.removeFailed` accepts only a failed, non-live session. In one database
transaction it deletes that DROIDEX session plus its canonical child, turn, and
event rows through foreign-key cascades, then emits `session.removed`. It never
deletes provider-native history, old Factory files, another session, or a live,
initializing, running, paused, or completed session. Removal is explicit and is
not an alias for close/hide.

- [ ] **Step 1: Write failing retry/removal transition and boundary tests**

Cover create-before-binding retry, exact-resume retry, missing native history,
second retry failure, generation and new-turn allocation, stale completion,
duplicate concurrent retry, retry racing close/removal, immutable
configuration, no resume-as-create, exact canonical cascade, rejected live or
nonfailed removal, bridge decoding, `session.updated`/`session.removed`, and
byte-identical untouched Factory/provider history.

- [ ] **Step 2: Run the failing production-path tests**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/persistence/TranscriptStore.test.ts sidecar/src/bridgeCommandParser.test.ts src/lib/commands.test.ts
```

- [ ] **Step 3: Implement the two strict transitions without a fallback path**

Keep SQL transition validation in `SessionStore`, turn ownership in
`TranscriptStore`, live/generation/provider sequencing in `SessionLifecycle`,
and dispatch only in `SessionManager`. Do not add a retry manager or retain a
removed summary in a compatibility cache.

- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionRegistry.test.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/persistence/TranscriptStore.test.ts sidecar/src/bridgeCommandParser.test.ts src/lib/commands.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/persistence/SessionStore.ts sidecar/src/persistence/SessionStore.test.ts sidecar/src/persistence/TranscriptStore.ts sidecar/src/persistence/TranscriptStore.test.ts sidecar/src/SessionLifecycle.ts sidecar/src/SessionLifecycle.test.ts sidecar/src/SessionManager.ts sidecar/src/SessionManager.sessionLifecycle.test.ts sidecar/src/SessionRegistry.ts sidecar/src/SessionRegistry.test.ts sidecar/src/bridgeSchemas/sessionCommands.ts sidecar/src/bridgeCommandParser.test.ts sidecar/src/protocol.ts src/types/bridge.ts src/lib/commands.ts src/lib/commands.test.ts
rtk git commit -m "feat(sessions): add explicit failed-start recovery"
```

### Task 9: Move child persistence and remove Factory-history truth

**Files:**

- Create: `sidecar/src/FactoryDefaults.ts`
- Create: `sidecar/src/FactoryDefaults.test.ts`
- Modify: `sidecar/src/ChildSessions.ts`
- Modify: `sidecar/src/ChildSessionsTypes.ts`
- Modify: `sidecar/src/ChildSessionState.ts`
- Modify: `sidecar/src/ChildSessions.test.ts`
- Modify: `sidecar/src/childSessionPersistence.test.ts`
- Modify: `sidecar/src/SessionManager.ts`
- Modify: `sidecar/src/testing/sessionManagerTestContext.ts`
- Delete: `sidecar/src/history.ts`
- Delete: `sidecar/src/sessionFileWatcher.ts`
- Delete: `sidecar/src/sessionFileCache.ts`
- Delete: `sidecar/src/sessionTranscript.ts`
- Delete: `sidecar/src/sessionTranscriptParser.ts`
- Delete: `sidecar/src/sessionSearch.ts`
- Delete: `sidecar/src/sessionHistoryAdmission.ts`
- Delete: `sidecar/src/historyAppSummaries.test.ts`
- Delete: `sidecar/src/historyChainReplay.test.ts`
- Delete: `sidecar/src/historyFileCache.test.ts`
- Delete: `sidecar/src/historyMissionHydration.test.ts`
- Delete: `sidecar/src/historyMissionProjection.test.ts`
- Delete: `sidecar/src/historyReplayRole.test.ts`
- Delete: `sidecar/src/historySessionIndex.test.ts`
- Delete: `sidecar/src/historySessionScan.test.ts`
- Delete: `sidecar/src/sessionSearch.test.ts`
- Delete: `sidecar/src/sessionTranscript.test.ts`
- Delete: `sidecar/src/sessionTranscriptParser.test.ts`
- Delete: `sidecar/src/sessionFileWatcher.test.ts`

`ChildSessions` reads and writes private child bindings through `SessionStore`
and pages transcript by `(parentAppSessionId, childSessionId)`. Move only the
still-valid Factory defaults JSON reader to `FactoryDefaults.ts`. Remove boot
reconcile, watcher, cache, Factory scan, and fake-history test infrastructure.
Tests use a temporary canonical database plus fake Droid runtime.

- [ ] **Step 1: Port the useful child/replay assertions to canonical tests**

Cover child round-trip, replacement, launch settings, canonical parent/child
filtering, equal timestamps, compaction-divider preservation, bounded replay,
and no top-level navigation row for a child.

- [ ] **Step 2: Run tests and verify old production imports still fail the cut**

```bash
rtk rg -n "from './(history|sessionFileWatcher|sessionFileCache|sessionTranscript|sessionSearch|sessionHistoryAdmission)\\.js'" sidecar/src
rtk mise exec node@22 -- node --import tsx --test sidecar/src/ChildSessions.test.ts sidecar/src/childSessionPersistence.test.ts sidecar/src/SessionManager.historyAndChildren.test.ts
```

- [ ] **Step 3: Cut children over and delete superseded modules/tests**

Delete only after `rtk rg` shows no production importer. Do not retain a
legacy reader, import command, watcher, or compatibility fixture.

- [ ] **Step 4: Run the complete sidecar suite and commit**

```bash
rtk mise exec node@22 -- npm --prefix sidecar run test
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add -u sidecar/src/history.ts sidecar/src/sessionFileWatcher.ts sidecar/src/sessionFileCache.ts sidecar/src/sessionTranscript.ts sidecar/src/sessionTranscriptParser.ts sidecar/src/sessionSearch.ts sidecar/src/sessionHistoryAdmission.ts sidecar/src/historyAppSummaries.test.ts sidecar/src/historyChainReplay.test.ts sidecar/src/historyFileCache.test.ts sidecar/src/historyMissionHydration.test.ts sidecar/src/historyMissionProjection.test.ts sidecar/src/historyReplayRole.test.ts sidecar/src/historySessionIndex.test.ts sidecar/src/historySessionScan.test.ts sidecar/src/sessionSearch.test.ts sidecar/src/sessionTranscript.test.ts sidecar/src/sessionTranscriptParser.test.ts sidecar/src/sessionFileWatcher.test.ts
rtk git add sidecar/src/FactoryDefaults.ts sidecar/src/FactoryDefaults.test.ts sidecar/src/ChildSessions.ts sidecar/src/ChildSessionsTypes.ts sidecar/src/ChildSessionState.ts sidecar/src/ChildSessions.test.ts sidecar/src/childSessionPersistence.test.ts sidecar/src/SessionManager.ts sidecar/src/testing/sessionManagerTestContext.ts
rtk git commit -m "refactor(history): remove Factory history ownership"
```

### Task 10: Hard-cut renderer snapshots to provider-aware v2

**Files:**

- Modify: `src/lib/sessionSnapshot.ts`
- Modify: `src/lib/sessionSnapshot.test.ts`
- Modify: `src/hooks/useStoreSessionSnapshot.test.ts`

Change the sole key to `droid-session-snapshot-v2`. Read only v2; never read,
migrate, or delete v1. Sanitization requires one complete nested
`SessionConfiguration`; it rejects top-level provider/model/mode/autonomy
fields, an unknown instance, or an invalid provider option value. Preserve all
current count and byte bounds.

- [ ] **Step 1: Write failing hard-cut tests**

Prove a valid v1 payload is ignored, v2 without a complete configuration or
with top-level duplicate configuration fields is ignored, and valid bounded v2
paints then yields to the authoritative sidecar list.

- [ ] **Step 2: Run the failing tests**

```bash
rtk mise exec node@22 -- node --import tsx --test src/lib/sessionSnapshot.test.ts src/hooks/useStoreSessionSnapshot.test.ts
```

- [ ] **Step 3: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test src/lib/sessionSnapshot.test.ts src/hooks/useStoreSessionSnapshot.test.ts
rtk mise exec node@22 -- npm run typecheck
rtk git add src/lib/sessionSnapshot.ts src/lib/sessionSnapshot.test.ts src/hooks/useStoreSessionSnapshot.test.ts
rtk git commit -m "refactor(sessions): hard-cut provider-aware snapshots"
```

### Task 11: Document and verify the canonical-storage checkpoint

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/runbooks.md`
- Modify: `docs/deployment-observability.md`
- Modify: generated docs only through `npm run docs:generate` if required

Document the database path, exact schema mismatch recovery, no Factory history
import/migration, provider-native files as resume-only, stable app identity,
private native identity, and existing paging/loading invariants.

- [ ] **Step 1: Add/update doc assertions if the docs checker supports them**
- [ ] **Step 2: Update docs and run the complete foundation gate**

```bash
rtk mise exec node@22 -- npm run format:check
rtk mise exec node@22 -- npm run typecheck
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run test
rtk mise exec node@22 -- npm --prefix sidecar run test
rtk mise exec node@22 -- npm run docs:check
rtk mise exec node@22 -- npm run quality:file-size
rtk mise exec node@22 -- npm run quality:deadcode
rtk mise exec node@22 -- npm run quality:boundaries
rtk mise exec node@22 -- npm run build
```

- [ ] **Step 3: Commit locally**

```bash
rtk git add docs/architecture.md docs/runbooks.md docs/deployment-observability.md
# Add generated docs only when docs:generate changed them.
rtk git commit -m "docs(architecture): document canonical session storage"
```

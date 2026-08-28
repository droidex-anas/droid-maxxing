# Multi-provider runtime

## Status

Approved to plan against on current `origin/main`.

This is the port of the 2026-08-12 multi-provider runtime design onto today’s
code. The original local branch `integration/multi-provider-v1` at `df601ecd`
was never pushed, so this document is the canonical spec for cloud and later
implementation work.

## Verified baseline

- Repository: `origin/main` at `6b99643327a9b67cd2ab8d0a1671ed771e82629b`
- Original local base named in that worktree: `6890d1f1` (v1.1.2, 2026-08-12)
- That SHA is an ancestor of current `main`. Everything after it, including
  the performance roadmap in `#137`, stays in force.
- Runtime for later implementation: Node 22
- Product policy: one canonical current implementation; no dual commands,
  fallback fields, or silent recovery

## Outcome

After this work:

- A DROIDEX session is owned by exactly one runtime provider for its whole
  life.
- The renderer stays provider-neutral. It speaks DROIDEX domain contracts
  only: session, child, transcript, permission, question, context, catalog,
  and runtime health.
- Factory/Droid and Codex remain distinct adapters. Session modules do not
  pretend the two SDKs are the same object.
- `FactoryRuntime` / `DroidRuntime` stay the Factory seam. They are not
  renamed into a universal SDK.
- Codex gets its own adapter, normalizer, catalog, auth/status, and session
  file enumerator.
- Mission Control, Spec mode, and Factory MCP session APIs stay Factory-only
  and fail fast on Codex sessions.
- `appSessionId` remains the only UI identity. Backend identity stays
  replaceable and is never stored as a renderer session or child key.

## Why this boundary

AGENTS.md already requires:

- a provider-neutral renderer;
- Factory, Droid, and Codex types kept out of presentation code;
- real provider differences translated at the provider seam, not hidden
  behind a misleading universal abstraction.

The current sidecar does not match that rule. `FactoryRuntime` is the named
Factory seam, but Factory SDK types leak through the rest of session core:

| Owner | Current Factory coupling |
| --- | --- |
| `SessionLifecycle` | `LiveSession.session: FactorySession` |
| `ChildSessionState` | `ChildRuntimeState.session: FactorySession` and `ChildParentLease.session` |
| `SessionEventFlow` | `DroidStreamEvent` before `normalize.ts` |
| `SessionContext` | `FactoryRuntime.readContextBreakdown` / `FactorySession` |
| `SessionInteractions` | `FactorySession` permission/question handlers |
| `SessionCompaction` / `sessionCompactionExecution` | Factory `compactSession` / replacement |
| `McpSettings` | Factory MCP server APIs |
| `ChildSessions` | `factoryReasoningEffort` and Factory load |
| History index | `~/.factory/sessions` JSONL tree |
| Bridge `runtime.updated` | `{ mode: 'cli_auth', droidPath, apiKeyConfigured }` |
| `FactoryDefaultSettings` | Factory model/mission defaults |

`SessionEventFlow` already has the right product boundary: it should consume
DROIDEX `NormalizedEvent` values. Factory `normalize.ts` is the Factory
translator. Codex needs the same kind of translator, not a fake
`FactorySession`.

Post-August-12 systems stay provider-agnostic and must not be reopened:

- ordered bridge protocol 3 and batch/replay;
- session and child runtime retirement;
- history writer/index workers and FTS5;
- renderer transcript chunks and feed projection;
- hot-path normalize/persist/emit metrics.

## Vocabulary

Do not reuse one word for two identities.

| Term | Meaning |
| --- | --- |
| `runtimeProviderId` | Durable session owner: `factory` or `codex` |
| `providerSessionId` | Replaceable backend session identity inside that owner |
| `appSessionId` | Stable DROIDEX parent identity |
| `childSessionId` | Stable logical child identity inside its parent |
| `ModelInfo.provider` | LLM vendor of a model id (`anthropic`, `openai`, …). Unrelated to `runtimeProviderId` |

`runtimeProviderId` is required on every live and persisted parent summary.
It does not change for the life of the session. Compaction may replace
`providerSessionId`; it must not change `runtimeProviderId`.

## Decision 1: two adapters, no universal SDK

Keep three layers:

1. DROIDEX domain: protocol, `SessionManager`, registry, lifecycle, children,
   timeline, context, compaction policy, interactions, event flow, history.
2. Factory adapter: `DroidRuntime`, Factory `normalize.ts`, Factory catalog,
   Factory auth, Factory session-file enumerator.
3. Codex adapter: Codex runtime, Codex normalizer, Codex catalog, Codex auth,
   Codex session-file enumerator.

Session core talks to an adapter only through DROIDEX operations it actually
owns:

- create, load, stream, interrupt, update settings, compact, close;
- catalog and auth/status;
- context snapshot when the adapter can produce one;
- session-file reconciliation entries tagged with `runtimeProviderId`.

An adapter may refuse an operation. Refusal is a visible, coded error, not a
no-op and not a silent Factory fallback.

Forbidden:

- a plugin/registry of arbitrary future providers;
- a `ProviderRuntime` interface that is just `FactorySession` with the labels
  sanded off;
- routing Codex through `DroidClient` / `@factory/droid-sdk`;
- renderer imports of Factory or Codex SDK types;
- fake composer controls for Spec, AGI, or Mission Control on Codex sessions.

## Decision 2: session create names the owner

`session.create` carries an explicit `runtimeProviderId`. The sidecar fails
fast when it is missing, unknown, or incompatible with the requested mode.

Rules:

- `factory` + `auto` | `spec` | `agi` keeps current Factory behavior.
- `codex` + `auto` is the Codex chat path.
- `codex` + `spec` or `agi` is rejected. Spec and Mission Control are Factory
  product behavior, not a Codex costume.
- `sessionPurpose: mission-control` is Factory-only.
- An existing session cannot be retargeted to another runtime provider.
  The user creates a new session.
- The renderer always sends `runtimeProviderId`. There is no sidecar default.

Child sessions inherit the parent’s `runtimeProviderId`. A Factory parent
cannot open a Codex child, and the reverse is also rejected.

## Decision 3: identity and aliases are composite

`SessionRegistry` aliases today are a flat `providerSessionId → appSessionId`
map. That is safe only while every backend id comes from Factory.

Canonical alias key:

```ts
type RuntimeProviderId = 'factory' | 'codex';

type ProviderAliasKey = {
  runtimeProviderId: RuntimeProviderId;
  providerSessionId: string;
};
```

Lookup, replacement, compaction chains, live-runtime journal rows, history
search identity, and child provider uniqueness all use that pair.

`providerSessionId` remains the backend id string. It is never a renderer
navigation key.

## Decision 4: live handles are a discriminated union

`LiveSession.session: FactorySession` is the leak that forces every caller
through Factory.

Replace it with an explicit union owned by session core:

```ts
type LiveRuntimeHandle =
  | { runtimeProviderId: 'factory'; session: FactorySession }
  | { runtimeProviderId: 'codex'; session: CodexSession };
```

`LiveSession` keeps DROIDEX turn state (`streaming`, queues, MCP resource
handles that DROIDEX owns, compaction overlap, unsubscribe). The handle is
the only provider-specific field.

The same shape applies to `ChildRuntimeState` and `ChildParentLease`.

SessionLifecycle, ChildSessions, SessionCompaction, SessionContext, and
McpSettings must not grow Codex SDK details. They switch on
`runtimeProviderId` and call the matching adapter. Factory SDK types stay
inside the Factory adapter and the Factory arm of the union.

Deletion test: if the Codex arm is deleted, Factory behavior is unchanged
and Codex create/load/send paths disappear. If a new “generic session”
wrapper is deleted and the only thing left is forwarding to FactorySession,
that wrapper is rejected.

## Decision 5: normalize before session core

`SessionEventFlow.handleStreamEvent` currently accepts `DroidStreamEvent`.
Change the production entry to `NormalizedEvent`.

- Factory: existing `normalize.ts` remains the Factory translator.
- Codex: a Codex normalizer emits the same `NormalizedEvent` / transcript
  kinds it can honestly represent.
- Unknown or untranslatable Codex events are dropped only when they have no
  DROIDEX meaning; they are not rewritten into fake assistant text.
- Mission, feature, and Factory task-child signals stay in the Factory
  normalizer. The Codex normalizer does not emit them.

Hot-path `recordNormalize` stays at each translator, so replay and perf
gates keep one normalize stage.

## Decision 6: capability surface

Codex v1 supports only operations it can perform without lying.

| DROIDEX operation | Factory | Codex v1 |
| --- | --- | --- |
| create / load / send / sendNow / interrupt / close | yes | yes |
| update model / reasoning / autonomy when the backend has an equivalent | yes | yes, or coded refusal |
| catalog.models | Droid CLI help | Codex catalog |
| runtime/auth status | Droid CLI + Factory key | Codex CLI + Codex auth |
| spec mode | yes | no, fail fast |
| AGI / Mission Control | yes | no, fail fast |
| Factory MCP add/remove/toggle/auth | yes | no, fail fast |
| compact / fork / rewind | yes | only with a real Codex equivalent; otherwise fail fast |
| DROIDEX-owned native browser | yes, via Factory MCP wiring | only if Codex can take the same local MCP servers; otherwise the browser remains DROIDEX-owned and Codex sessions do not advertise agent browser tools |
| Factory child workers/validators | yes | no Codex child runtime in v1 |

The renderer disables unsupported commands. Disabled controls are not shown
as armed buttons. The sidecar still rejects the command if it arrives.

DROIDEX-owned surfaces stay DROIDEX-owned: native browser, history SQLite,
bridge transport, retirement budgets, transcript projection.

## Decision 7: persistence hard cut

Canonical `session-index.sqlite` becomes schema version 3.

`app_sessions` and `child_sessions` gain `runtime_provider_id TEXT NOT NULL`
with a check constraint `IN ('factory', 'codex')`. Provider-session unique
indexes include `runtime_provider_id`.

Direct upgrades from schema v2 rewrite existing rows to
`runtime_provider_id = 'factory'` in one transaction, then set
`PRAGMA user_version = 3`. After that rewrite the column is required. There
is no reader that treats a missing column as Factory.

This follows the existing v1 → v2 child-schema rewrite: one supported legacy
state, fail-fast recovery for anything else, documented deletion criterion.

Deletion criterion: remove the v2 rewrite after the release that no longer
supports upgrading a v1.1.x / schema-v2 index. Track that boundary on the
implementation issue.

Any other schema, including a v3 database missing the check constraint, keeps
the current recovery instruction: quit, delete the canonical index WAL files,
restart. Raw Factory and Codex session files are not deleted.

`live-runtime.json` rows include `runtimeProviderId`. Adoption refuses a row
that lacks it.

Derived `session-search.sqlite` and the Factory file cache remain rebuildable.
Codex files are a second enumerator, tagged with `runtimeProviderId: 'codex'`.
A missed delta still triggers an authoritative snapshot. The orchestration
thread still does not walk provider file trees.

## Decision 8: runtime health and catalogs

`runtime.updated` stops being a single Factory CLI record.

```ts
type RuntimeProviderStatus =
  | {
      runtimeProviderId: 'factory';
      available: boolean;
      droidPath?: string;
      apiKeyConfigured: boolean;
      message?: string;
    }
  | {
      runtimeProviderId: 'codex';
      available: boolean;
      codexPath?: string;
      authenticated: boolean;
      message?: string;
    };

interface RuntimeStatus {
  providers: RuntimeProviderStatus[];
}
```

`catalog.models` is scoped by `runtimeProviderId`. The renderer keeps separate
model lists and does not mix Factory and Codex ids in one picker.

`settings.defaults` remains Factory defaults for Factory sessions. Codex
sessions use a Codex defaults event or the same event with an explicit
`runtimeProviderId`. Do not reuse `FactoryDefaultSettings` as a Codex payload.

`connect` may still accept a Factory API key for the Factory adapter. Codex
auth stays on the Codex adapter. One adapter’s missing CLI does not block the
other adapter from creating sessions.

## Renderer

The renderer may show `runtimeProviderId` as a session fact and as a create
choice. It must not import Factory or Codex SDKs.

Required UI behavior:

- Composer create target includes an explicit Factory / Codex choice.
- Session rows and summaries expose `runtimeProviderId`.
- Spec, AGI, Mission Control, Factory MCP, and Factory-only child spawn
  controls are unavailable on Codex sessions.
- Onboarding and environment detection report each adapter separately.
- Model pickers read the catalog for the session’s runtime provider only.

Do not ship a control that looks active and then no-ops.

## Module ownership

New production files stay feature-local until a second consumer exists.

| Module | Owns |
| --- | --- |
| `sidecar/src/protocol.ts` and `src/types/bridge.ts` | `runtimeProviderId`, runtime status, catalog scoping. Keep mirrors in the same change. |
| `sidecar/src/DroidRuntime.ts` | Factory seam only |
| `sidecar/src/normalize.ts` | Factory → `NormalizedEvent` |
| `sidecar/src/codex/CodexRuntime.ts` | Codex process/session adapter |
| `sidecar/src/codex/codexNormalize.ts` | Codex → `NormalizedEvent` |
| `sidecar/src/codex/codexCatalog.ts` | Codex model catalog |
| session core (`SessionManager`, lifecycle, children, …) | DROIDEX operations, routing, fail-fast capability checks |
| `SessionEventFlow` | `NormalizedEvent` application only |
| history workers | canonical SQLite plus provider-tagged file enumerators |
| renderer | provider-neutral presentation and command targeting |

Do not add `Utils`, `ProviderManager`, or a registry. `SessionManager` remains
the composition root and constructs the two adapters.

File-size rule: do not grow `SessionLifecycle.ts`, `ChildSessions.ts`,
`SessionManager.ts`, or `history.ts` across the 500-line review ceiling with
Codex details. Put Codex behavior in the Codex module. Extract a Factory
execution helper only when the Factory arm would otherwise keep spreading
SDK types through session core.

## Non-goals

- A third runtime provider.
- Studio, DNA, or canvas work.
- Changing bridge protocol 3 batching, replay, or snapshot recovery.
- Changing retirement budgets, transcript chunks, or FTS5 pacing.
- Importing historical Factory JSONL into a new DROIDEX-owned transcript
  format.
- Teaching Codex to run Mission Control, Spec mode, or Factory MCP APIs.
- Compatibility shims for sessions that omit `runtimeProviderId` after the
  schema v3 rewrite.
- Authenticated Factory or Codex network calls in CI.

## Risks to contain

- Alias collision if `providerSessionId` maps are left flat.
- SessionLifecycle absorbing Codex SDK types and becoming a second runtime.
- Renderer model vendor (`ModelInfo.provider`) confused with
  `runtimeProviderId`.
- History indexer treating Codex files as Factory JSONL.
- Showing Spec/AGI controls on Codex sessions.
- A generic runtime wrapper that only forwards to Factory.

## Validation

Implementation must cover:

- Factory create/resume/send/interrupt/close characterization remains green
  with `runtimeProviderId: 'factory'` explicit on every create.
- Missing, unknown, or Codex+`agi`/`spec` create commands fail fast and
  create no live session, MCP resource, or history row.
- Registry aliases never resolve a Factory id as Codex or the reverse.
- Compaction replacement keeps `runtimeProviderId` and updates only
  `providerSessionId`.
- Schema v2 indexes rewrite to v3 Factory rows; any other schema still
  uses the current recovery diagnostic.
- `SessionEventFlow` tests feed `NormalizedEvent`, not `DroidStreamEvent`.
- Codex fake runtime: create, stream, interrupt, close, coded refusal for
  Spec/AGI/MCP, no Factory SDK types in the Codex module.
- Renderer command targeting: Codex session cannot dispatch Spec, AGI,
  Mission, or Factory MCP commands.
- Protocol mirrors stay in sync, including `bridgeWireValidation.ts`.
- History enumerator tags Factory and Codex files separately; mixed trees
  cannot overwrite each other’s derived rows.
- Live-runtime adoption refuses rows without `runtimeProviderId`.
- Existing Factory perf replay scenarios keep their invariants.

Authenticated Factory and Codex smokes remain pending unless the owner
explicitly authorizes them.

## Review against current main

Confirmed.

The original 2026-08-12 local commit is not on GitHub, but the design above
is the one this environment should implement. It matches current ownership,
the hard-cut persistence policy, the Factory seam introduced by session-core
extraction, and the post-August-12 transport, history, and retirement work.

Ready for the implementation plan: file ownership, test-first tasks, parallel
worktrees, and small commit boundaries.

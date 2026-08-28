# Multi-provider runtime implementation plan

> For agentic workers: implement this plan task by task against
> `docs/superpowers/specs/2026-08-12-multi-provider-runtime-design.md`.
> Keep checklist status current as work lands. Do not start production
> edits until the task’s tests exist and fail for the right reason.

## Goal

Make a DROIDEX session owned by exactly one runtime provider (`factory` or
`codex`) without turning Factory and Codex into one fake SDK.

Factory behavior stays the current product path. Codex is a second adapter
with an honest, smaller capability surface. The renderer stays
provider-neutral.

## Worktree layout

Create worktrees from a freshly fetched `origin/main`. Do not edit the
primary checkout.

Serial trunk, then two parallel tracks:

| Worktree | Branch | Owner | Depends on |
| --- | --- | --- | --- |
| contracts | `feat/multi-provider-contracts` | either | none |
| factory-seam | `feat/multi-provider-factory-seam` | Claude | contracts |
| renderer-contracts | `feat/multi-provider-renderer` | Codex | contracts |
| codex-adapter | `feat/multi-provider-codex` | Codex | factory-seam |
| history-codex | `feat/multi-provider-history` | Claude | contracts; merge factory-seam before done |
| integration | `feat/multi-provider-v1` | either | all of the above |

`feat/multi-provider-v1` is the only branch that merges the tracks. Do not
merge Factory-seam and Codex-adapter into each other while both are in
flight.

## File ownership

### Contracts track — both protocol mirrors plus persistence identity

- `sidecar/src/protocol.ts`
- `src/types/bridge.ts`
- `src/lib/bridgeWireValidation.ts`
- `sidecar/src/history.ts` (schema v3 only; no Codex enumerator yet)
- `sidecar/src/historyWriteStatements.ts`
- `sidecar/src/historyPersistenceDatabase.ts`
- `sidecar/src/SessionRegistry.ts`
- `sidecar/src/liveRuntimeJournal.ts`
- tests beside those files

### Factory-seam track — stop Factory types at the adapter

- `sidecar/src/normalize.ts`
- `sidecar/src/SessionEventFlow.ts`
- `sidecar/src/SessionLifecycle.ts`
- `sidecar/src/ChildSessionState.ts`
- `sidecar/src/ChildSessions.ts`
- `sidecar/src/childRuntimeOpen.ts`
- `sidecar/src/sessionHelpers.ts`
- `sidecar/src/sessionCompactionExecution.ts`
- `sidecar/src/SessionContext.ts`
- `sidecar/src/SessionInteractions.ts`
- `sidecar/src/McpSettings.ts`
- `sidecar/src/SessionManager.ts` (construct adapters, route create)
- `sidecar/src/testing/fakeFactoryRuntime.ts`
- `sidecar/src/DroidRuntime.ts` only if create options need
  `runtimeProviderId` threaded through

Do not put Codex types in this track.

### Renderer track — consume the new protocol, Factory still the only live backend

- `src/hooks/useStore.tsx` and focused store tests
- `src/hooks/useOnboarding.ts`
- `src/lib/bridge.ts`
- composer / session-create UI
- session summary / sidebar presentation
- capability gating for Spec, AGI, Mission Control, Factory MCP

### Codex-adapter track — new module

- `sidecar/src/codex/CodexRuntime.ts`
- `sidecar/src/codex/codexNormalize.ts`
- `sidecar/src/codex/codexCatalog.ts`
- `sidecar/src/testing/fakeCodexRuntime.ts`
- SessionManager wiring to construct CodexRuntime
- fail-fast capability tests

### History-Codex track

- Factory enumerator stays the Factory JSONL tree
- new Codex enumerator tagged `runtimeProviderId: 'codex'`
- search identity and file-cache keys include `runtimeProviderId`
- derived DB rebuild remains allowed; canonical schema is not rebuilt from
  Codex files

## Guardrails

- No `ProviderManager`, registry, or generic `Utils`.
- No Factory SDK types in `sidecar/src/codex/`.
- No Codex SDK types in Factory files.
- Do not grow `SessionLifecycle.ts`, `ChildSessions.ts`, `SessionManager.ts`,
  or `history.ts` across the 500-line review ceiling with adapter details.
- Protocol mirrors change in the same commit.
- Every behavior change has a focused test. Race fixes are deterministic.
- No authenticated Factory or Codex network calls unless the owner
  explicitly authorizes them.
- Do not edit architecture.md until the integration branch has the behavior.

## Track 0 — contracts (serial)

### Task 0.1: protocol identity

Test first:

- sidecar protocol / registry tests: `session.create` without
  `runtimeProviderId` fails; unknown ids fail; valid `factory` is accepted
  by the type and a summary round-trip.
- `src/lib/bridgeWireValidation.ts`: `runtime.updated` with `providers[]`
  accepts Factory and Codex statuses; rejects the old single
  `{ mode: 'cli_auth' }` shape.
- renderer/sidecar protocol mirrors stay identical for the new fields.

Production:

- Add `RuntimeProviderId`, required `runtimeProviderId` on `SessionSummary`
  and `session.create`.
- Replace `RuntimeStatus` with `providers: RuntimeProviderStatus[]`.
- Scope `catalog.models` with `runtimeProviderId`.
- Keep `ModelInfo.provider` as LLM vendor. Do not reuse it.

Commit: `feat(protocol): require runtimeProviderId on sessions`

### Task 0.2: registry aliases

Test first:

- Factory and Codex can use the same `providerSessionId` string without
  resolving to each other.
- Compaction replacement updates `providerSessionId` and preserves
  `runtimeProviderId`.
- Historical alias lookup is composite.

Production: `SessionRegistry` alias maps keyed by
`runtimeProviderId + providerSessionId`.

Commit: `feat(sidecar): namespace provider aliases by runtime`

### Task 0.3: schema v3

Test first:

- empty DB creates schema v3 with `runtime_provider_id`.
- v2 Factory index rewrites to v3 with `factory` in one transaction.
- any other schema still throws the current recovery diagnostic.
- child unique indexes include `runtime_provider_id`.
- `live-runtime.json` rows without `runtimeProviderId` are refused.

Production: bump `HISTORY_SCHEMA_VERSION` to 3, one v2 rewrite, journal
field. Document the rewrite’s deletion criterion in `history.ts` next to
the existing v1 → v2 comment.

Commit: `feat(history): persist runtimeProviderId in schema v3`

Merge contracts to a shared base before the parallel tracks.

## Track 1 — Factory seam (Claude worktree)

### Task 1.1: event flow consumes NormalizedEvent

Test first: `SessionEventFlow` tests pass `NormalizedEvent` fixtures, not
`DroidStreamEvent`. Factory `normalize.ts` tests still cover Factory stream
translation.

Production: `handleStreamEvent` takes `NormalizedEvent`. Factory lifecycle
and child open normalize, then call event flow.

Commit: `refactor(sidecar): isolate Factory stream normalization`

### Task 1.2: live handle union

Test first: lifecycle and child tests still pass with
`{ runtimeProviderId: 'factory', session }`. A Codex handle in those tests
is not required yet, but the type must allow it.

Production: `LiveSession`, `ChildRuntimeState`, and `ChildParentLease` use
the discriminated union. Factory call sites narrow with
`runtimeProviderId === 'factory'`.

Commit: `refactor(sidecar): discriminate live runtime handles`

### Task 1.3: create/load routing

Test first:

- Factory create still produces one Factory `createSession` call.
- A create with `runtimeProviderId: 'codex'` fails in this track with a
  coded “codex unavailable” error until Track 3 lands, and leaves no live
  session. Do not add a stub Codex adapter here.

Production: `SessionLifecycle.create` / `resume` read `runtimeProviderId`
and only call `DroidRuntime` for `factory`.

Commit: `feat(sidecar): fail-fast non-factory creates until Codex lands`

If Track 3 is already merged, skip the temporary refusal and call the
Codex adapter instead. Do not keep both a stub and a real adapter.

## Track 2 — renderer contracts (Codex worktree, parallel with Track 1)

### Task 2.1: store and wire validation

Test first: store tests for `runtime.updated` with two provider statuses;
create command includes `runtimeProviderId: 'factory'` by default from the
composer snapshot, same fail-fast rule as autonomy.

Production: onboarding, environment, and runtime health read
`status.providers`. No `cli_auth`-only assumption left in the renderer.

Commit: `feat(renderer): consume multi-provider runtime status`

### Task 2.2: create choice and capability gating

Test first:

- composer sends the selected `runtimeProviderId`.
- Codex target hides Spec, AGI, Mission Control, and Factory MCP.
- Factory target keeps current controls.
- no armed no-op buttons.

Production: smallest composer/session UI change that makes the choice
real. Do not restyle the app.

Commit: `feat(renderer): select runtime provider on create`

## Track 3 — Codex adapter (Codex worktree, after Track 1)

### Task 3.1: fake Codex runtime

Test first, against a fake:

- create/load/stream/interrupt/close.
- Spec/AGI/MCP/compact-without-equivalent refuse with stable codes.
- no `@factory/droid-sdk` import in `sidecar/src/codex/`.

Production: `CodexRuntime` + `fakeCodexRuntime`. SessionManager constructs
it. Lifecycle calls it only for `runtimeProviderId: 'codex'`.

Commit: `feat(sidecar): add Codex runtime adapter`

### Task 3.2: Codex normalizer

Test first: representative Codex stream events become `NormalizedEvent`
transcripts; Factory-only mission/child signals are not emitted.

Production: `codexNormalize.ts`. Codex stream loop normalizes, then calls
`SessionEventFlow`.

Commit: `feat(sidecar): normalize Codex streams into DROIDEX events`

### Task 3.3: Codex catalog and auth

Test first: `catalog.models` with `runtimeProviderId: 'codex'` returns the
Codex fake catalog; Factory catalog is unchanged. Runtime status lists both
adapters independently.

Commit: `feat(sidecar): report Codex catalog and auth status`

## Track 4 — history enumerator (Claude worktree)

### Task 4.1: tag Factory file rows

Test first: Factory JSONL reconciliation entries include
`runtimeProviderId: 'factory'`. Existing Factory history tests stay green.

Commit: `feat(history): tag Factory file index with runtimeProviderId`

### Task 4.2: Codex enumerator

Test first: Codex files cannot clobber Factory derived rows when backend
ids collide. Snapshot rebuild still does not mutate canonical sessions.

Production: Codex enumerator only. Do not parse Codex files with the
Factory JSONL reader.

Commit: `feat(history): index Codex session files`

## Track 5 — integration branch

### Task 5.1: merge and delete temporary refusals

Remove the Track 1 “codex unavailable” refusal if it still exists. One
canonical create path per `runtimeProviderId`.

### Task 5.2: architecture and recovery docs

Update `docs/architecture.md` to the current system:

- `runtimeProviderId` ownership;
- Factory vs Codex adapters;
- composite aliases;
- schema v3 and the v2 rewrite deletion criterion;
- renderer remains provider-neutral.

Run `npm run docs:generate` and `npm run docs:check` if scripts or
environment docs changed. They should not need to for this work unless
new env vars appear (`CODEX_PATH` or similar). If a Codex path override is
required, add it to `.env.example` and AGENTS.md in this commit.

Commit: `docs: record multi-provider runtime ownership`

### Task 5.3: validation

From the integration worktree:

```bash
npm run format:check
npm run typecheck
npm run sidecar:typecheck
npm run electron:check
npm run test
npm --prefix sidecar run test
npm run docs:check
```

Focused perf check after event-flow or history enumerator changes:

```bash
npm run perf:replay -- --scenario smoke
```

Authenticated Factory/Codex smokes: pending unless explicitly authorized.

## Suggested parallel assignment

Once Track 0 is on `origin` (or a shared integration base):

- Claude: Track 1, then Track 4.
- Codex: Track 2 immediately; Track 3 after Track 1 is reviewable.

Do not let Track 3 rewrite SessionLifecycle while Track 1 is extracting
the live handle. If both need the same file, Track 1 wins; Track 3 waits.

## Done when

- Factory chats behave as they do on `origin/main`, with explicit
  `runtimeProviderId: 'factory'`.
- Codex chats can be created, streamed, interrupted, and closed through
  the fake in tests, and through the real adapter when a local Codex CLI
  is present.
- Spec/AGI/Mission/Factory MCP cannot be started on a Codex session.
- Registry, history, and journal identities are composite.
- Renderer has no Factory or Codex SDK types.
- Docs match the current system.

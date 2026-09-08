# Codex and Claude Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox syntax for tracking.

**Goal:** Add production Codex app-server and Claude Agent SDK providers behind
the tested DROIDEX provider seam, without importing T3’s server architecture.

**Architecture:** Each provider owns discovery, translation, one live native
session, interactions, and cleanup. Codex owns one `codex app-server` child and
one root thread per DROIDEX session. Claude owns one long-lived SDK `Query` and
one prompt iterator per session. Both emit the canonical provider contract from
the shared checkpoint.

**Frozen upstream inputs:**

- T3 Code: `849bac8946c40420174b4187e36fcf17b5ea7cc4`
- Official Codex generated protocol:
  `678157acaa819d5510adfe359abb5d0392cfe461`
- Claude Agent SDK: exact `0.3.170` (observed Claude Code payload `2.1.170`)

## Global Constraints

- Begin only after Provider Core/Droid is green and its checkpoint SHA is
  recorded. The integration owner performs Task P0's single T3 refresh; adapter
  branches derive only from that reviewed immutable input.
- Adapter branches own only their provider directory, focused fixtures/tests,
  and the preassigned Claude dependency/lockfile. They do not edit shared
  contracts, lifecycle, manager, registry, bridge types, or renderer.
- Port T3 protocol knowledge, behavior, and tests into plain TypeScript. Do not
  port Effect, T3 services/layers/server/event store/thread model, shadow homes,
  raw observability, or resume fallbacks.
- Native IDs and raw messages never cross the renderer bridge. Diagnostics are
  structural, bounded, and redacted.
- Consume the corrected Provider Core checkpoint exactly:
  `ProviderTurnInput` carries the captured `SessionConfiguration`;
  `startTurn` resolves `Promise<void>` only when the native turn is accepted;
  the generation-checked canonical `turn.settled` event is the sole terminal
  authority; interrupt receives the captured canonical `turnId` and
  `runtimeGeneration`; `binding.updated` carries opaque cursor/native
  replacement to `SessionLifecycle` for compare-and-swap persistence; and
  `close` receives the application's absolute `ShutdownDeadline`. Adapter code
  never imports or writes `SessionStore`,
  `TranscriptStore`, or SQLite.
- Each session's pre-activation event buffer has the foundation's exact limits:
  512 events and 1,048,576 serialized UTF-8 bytes. Overflow fails the open,
  discards buffered output, settles native callbacks, and closes the native
  session before it can activate.
- Every new production file is cohesive and below 500 lines.
- Every task commit is independently buildable: it contains every touched file
  named by that task, all source headers and `PROVENANCE.md` rows required by
  the task-local source map, and no import of a file deferred to a later task.
  Run the focused tests, `sidecar:typecheck`, and `sidecar:build` before each
  task commit.
- Deterministic protocol, provenance, legal/use approval, and packaged-runtime
  feasibility pass before staged registration. The convergence branch may
  compile and locally register a provider that truthfully reports
  `unavailable`, `unsupported`, or explicitly experimental. Authenticated and
  signed packaged smokes remain release and readiness-marketing blockers; they
  are not prerequisites for compiling that staged registration.
- Work and commits remain local; never push.

## Shared provenance checkpoint

### Task P0: Refresh once and land provenance/legal preparation before probing

Run this task on `integration/multi-provider-v1` after Provider Core/Droid and
before creating either adapter worktree.

**Files:**

- Create: `docs/provider-provenance.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `third_party/t3-code/LICENSE`
- Create: `third_party/codex-app-server/NOTICE`
- Create: `third_party/claude-agent-sdk/LICENSE.md`

Fetch T3 `origin/main` exactly once in the research checkout and record its full
SHA. Compare the mapped Codex/Claude provider files with the reviewed pin. If
they changed, stop, review the diff, and update the design plus this plan before
deriving code. Record the official Codex protocol ref, the exact reviewed
Claude SDK package version, upstream licenses/notices, referenced Anthropic
legal agreements, and the planned source-to-derived-path map. Do not invent a
CLI, app-server, payload, integrity, or other native version value: P0 records
only values supported by retrieved primary-source evidence. The T3 map includes
its latest adapter directory at
`apps/server/src/provider/{Drivers,Layers,Services}` and the upstream
`packages/effect-codex-app-server` package. This is attribution and a review
record, not permission to import T3's architecture.

Before any Claude probe, dependency install, packaging spike, or runtime code,
an authorized human must record an explicit go/no-go in
`docs/provider-provenance.md` for use and redistribution of the pinned
Anthropic all-rights-reserved SDK and its required non-CLI assets. The decision
must state that DROIDEX is a local UI using the official Agent SDK with a
user-installed Claude CLI; it does not redistribute optional platform
executables, implement login, proxy credentials, or claim an Anthropic client
identity. Missing or negative approval is `BLOCKED`: do not run Claude V0 or
create the Claude runtime branch. A no-go may leave only truthful setup/status
UI that directs the user to Anthropic's official SDK and user-installed CLI.

- [ ] **Step 1: Refresh, compare, and freeze the immutable inputs**
- [ ] **Step 2: Copy reviewed notices/licenses verbatim and write the source map**
- [ ] **Step 3: Record the explicit human Anthropic use/redistribution go/no-go**
- [ ] **Step 4: Commit the shared provenance/legal checkpoint locally**

```bash
rtk git add docs/provider-provenance.md THIRD_PARTY_NOTICES.md third_party/t3-code/LICENSE third_party/codex-app-server/NOTICE third_party/claude-agent-sdk/LICENSE.md docs/superpowers/specs/2026-08-12-multi-provider-runtime-design.md
rtk git commit -m "docs(providers): freeze adapter provenance and legal review"
```

Every adapter task that substantially derives code or tests from an upstream
file adds a concise source header to that derived file and updates the
provider-local `PROVENANCE.md` in the same commit. Those local maps merge later
without cross-branch conflicts.

Use this exact header, with all source paths represented when a file has more
than one mapped source:

```ts
// Derived in part from T3 Code <exact-source-path> at 849bac8946c40420174b4187e36fcf17b5ea7cc4 (MIT); see PROVENANCE.md.
```

Every destination in the task-local maps below is conservatively treated as a
substantial derivation: the task commit must add that header and the matching
`PROVENANCE.md` row. Do not land a mapped file in one commit and its attribution
in another. Official generated Codex protocol material uses its applicable
Apache-2.0 header and frozen official ref instead of the T3 header.

### Task V0: Freeze tested native versions and rejection fixtures before coding

Run this stop-gate task on `integration/multi-provider-v1` after P0 and before
creating either adapter worktree. Plan-authoring evidence establishes the SDK
package values below but does not responsibly establish a supported
user-installed Codex or Claude executable version. Do not infer an allowlist
from T3, semver proximity, `latest`, or whatever happens to be installed on one
developer machine.

**Files:**

- Create: `docs/provider-native-version-matrix.md`
- Create: `sidecar/src/providers/compatibility/fixtures/codex-supported.json`
- Create: `sidecar/src/providers/compatibility/fixtures/codex-rejected.json`
- Create: `sidecar/src/providers/compatibility/fixtures/claude-supported.json`
- Create: `sidecar/src/providers/compatibility/fixtures/claude-rejected.json`

| Surface | Plan-authoring evidence | Required V0 decision |
| --- | --- | --- |
| Codex `codex --version` | No exact supported value is locally proven | Record every exact accepted stdout value and normalized version after authenticated protocol tests |
| Codex initialize `userAgent` | No exact supported value is locally proven | Record every exact accepted string and its parsed version; prove CLI output and app-server identity agree |
| Claude Agent SDK | npm package `0.3.170` | Accept exactly `0.3.170` |
| SDK-declared Claude Code payload | package metadata `claudeCodeVersion: 2.1.170` | Fixture must observe exact init payload `claude_code_version: 2.1.170` |
| User-installed Claude `--version` | No exact executable output is locally proven | Record every exact accepted stdout value only after the SDK query fixture and authenticated probe agree |

Run each candidate through initialize, account, paginated models, required
approval/question methods, create/resume, turn, interrupt, and close. For
Claude also capture the sanitized init payload version, question/permission
shapes, prompt steering, and task controls. The supported fixtures contain the
literal command output, initialize/user-agent or init-payload version, and
capability results. Rejection fixtures contain malformed output, unknown
versions, CLI/server or CLI/payload mismatch, one reviewed adjacent lower
version, and one reviewed adjacent higher version; every rejection must produce
`unsupported_provider_version` before session mutation.

- [ ] **Step 1: Capture literal deterministic and authenticated probe evidence**
- [ ] **Step 2: Human-review the exact accepted matrix and rejection fixtures**
- [ ] **Step 3: Stop if either provider still lacks an exact supported pair**
- [ ] **Step 4: Commit the frozen matrix and fixtures locally**

```bash
rtk git add docs/provider-native-version-matrix.md sidecar/src/providers/compatibility/fixtures/codex-supported.json sidecar/src/providers/compatibility/fixtures/codex-rejected.json sidecar/src/providers/compatibility/fixtures/claude-supported.json sidecar/src/providers/compatibility/fixtures/claude-rejected.json
rtk git commit -m "test(providers): freeze supported native versions"
```

V0 is complete only when all five matrix rows contain exact reviewed values and
the rejection fixtures are executable test inputs. If the evidence cannot be
captured, stop the adapter program; do not create the runtime branches and do
not weaken discovery to a range. Fixture values must be literal captured
evidence, never examples, inferred adjacent versions, or author-invented
placeholders. Record the V0 commit SHA as `<native-version-checkpoint>`.

## Branch setup after the shared checkpoint

From the repository root—not from inside a nested worktree—create sibling local
worktrees with absolute paths:

```bash
rtk git worktree add /Users/anas/Documents/droid-control/.worktrees/multi-provider-codex -b integration/multi-provider-codex <native-version-checkpoint>
rtk git worktree add /Users/anas/Documents/droid-control/.worktrees/multi-provider-claude -b integration/multi-provider-claude <native-version-checkpoint>
```

Execute Codex Tasks C1-C5 and Claude Tasks A1-A5 concurrently with one writer
per worktree. Review each task before starting the next task on that branch.

---

## Codex branch

### Task C1: Implement the app-server transport and frozen protocol subset

**Files:**

- Create: `sidecar/src/providers/codex/CodexProtocol.ts`
- Create: `sidecar/src/providers/codex/CodexTransport.ts`
- Create: `sidecar/src/providers/codex/CodexTransport.test.ts`
- Create: `sidecar/src/providers/codex/CodexProcessTree.ts`
- Create: `sidecar/src/providers/codex/CodexProcessTree.test.ts`
- Create: `sidecar/src/providers/codex/PROVENANCE.md`
- Create: `sidecar/src/providers/codex/fixtures/fake-codex-app-server.mjs`
- Create: `sidecar/src/providers/codex/fixtures/protocol/transport-frames.jsonl`
- Create: `sidecar/src/providers/codex/fixtures/protocol/transport-requests.jsonl`

Source map in the frozen upstream checkout (not a DROIDEX path): T3
`packages/effect-codex-app-server/src/{client,protocol,_internal/stdio,_internal/shared}.ts`
and only the supported official generated definitions at the frozen Codex ref.
Do not copy the 40k-line generated schema; define and validate only messages
DROIDEX sends or consumes.

Transport requirements: newline-delimited JSON objects, monotonic numeric
request IDs, pending registration before a serialized write, separate response
/ server request / notification routing, and final unterminated EOF line.
Client request IDs remain monotonic numbers. Server requests accept only string
or numeric IDs and responses echo the exact received value and primitive type;
boolean, null, object, and array IDs fail structurally. Unknown requests return
`-32601` with that exact ID.

Set `MAX_STDOUT_LINE_BYTES = 1_048_576` and measure raw buffered UTF-8 bytes
before decoding JSON. Reject both an unterminated buffer that crosses the limit
and a completed line over the limit; terminate the process tree and reject all
pending requests exactly once. Malformed/unroutable envelopes are structural
failures. Continuously drain stderr into a redacted 65,536-byte diagnostic ring
without logging it.

Transport close accepts the core's absolute `ShutdownDeadline`: close stdin,
then terminate the whole native process tree without extending that deadline.
On POSIX, spawn the session as its own process group and signal the negative
PGID with TERM then KILL. On Windows, use `taskkill /pid <pid> /t` and add `/f`
for escalation. A missing/already-exited tree is successful idempotent cleanup;
other failures are sanitized and still leave all waiters settled.

- [ ] **Step 1: Add failing split/coalesced/CRLF, string/numeric ID echo,
      correlation, error, notification-order, unknown request/response,
      malformed/oversized frame, final EOF, pending settlement, stderr-pressure,
      POSIX/Windows process-tree, absolute-deadline, and termination-race tests**
- [ ] **Step 2: Run the failing transport test**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/CodexTransport.test.ts sidecar/src/providers/codex/CodexProcessTree.test.ts
```

- [ ] **Step 3: Implement the narrow protocol/transport**
- [ ] **Step 4: Validate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/CodexTransport.test.ts sidecar/src/providers/codex/CodexProcessTree.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/codex/CodexProtocol.ts sidecar/src/providers/codex/CodexTransport.ts sidecar/src/providers/codex/CodexTransport.test.ts sidecar/src/providers/codex/CodexProcessTree.ts sidecar/src/providers/codex/CodexProcessTree.test.ts sidecar/src/providers/codex/PROVENANCE.md sidecar/src/providers/codex/fixtures/fake-codex-app-server.mjs sidecar/src/providers/codex/fixtures/protocol/transport-frames.jsonl sidecar/src/providers/codex/fixtures/protocol/transport-requests.jsonl
rtk git commit -m "feat(codex): add the app-server transport"
```

### Task C2: Discover a supported Codex executable and exact capabilities

**Files:**

- Create: `sidecar/src/providers/codex/CodexExecutable.ts`
- Create: `sidecar/src/providers/codex/CodexExecutable.test.ts`
- Create: `sidecar/src/providers/codex/CodexDiscovery.ts`
- Create: `sidecar/src/providers/codex/CodexDiscovery.test.ts`
- Create: `sidecar/src/providers/codex/CodexModes.ts`
- Create: `sidecar/src/providers/codex/CodexModes.test.ts`
- Modify: `sidecar/src/providers/codex/PROVENANCE.md`

Resolve the user-installed `codex` without a shell, run `codex --version`, then
spawn a transient app-server. On Windows resolve PATH/PATHEXT first; execute a
real `.exe` directly, or resolve an npm `.cmd`/`.bat`/`.ps1` launcher to the
adjacent `node_modules/@openai/codex/bin/codex.js` and invoke it with
`process.execPath`. If the real entry is absent, report `missing_executable`;
never pass a launcher shim to `spawn` and never enable `shell`.

Install handlers before sending exactly this initialize payload, with the real
DROIDEX package version and no additional fields:

```ts
{
  clientInfo: {
    name: 'droidex_desktop',
    title: 'DROIDEX Desktop',
    version: appVersion,
  },
  capabilities: { experimentalApi: true },
}
```

Notify `initialized`, then call `account/read` and paginated `model/list`. Probe
skills/MCP only when the frozen supported CLI fixture proves them. Return only
sanitized executable/version, readiness, auth/account/billing labels, models,
reasoning/service-tier descriptors, capabilities, and closed recovery actions.
Close the transient process on every path.

Load the exact reviewed CLI/user-agent pairs from V0. Both values must match the
same supported fixture; malformed output, unknown values, or a mismatch is
`unsupported_provider_version` before account/model mutation. Only idempotent
discovery may use a small bounded overload retry; never retry
create/resume/turn mutation.

Mode/autonomy mapping:

| DROIDEX | Codex |
| --- | --- |
| `auto` | default collaboration mode |
| `spec` | plan collaboration mode |
| `agi` | unsupported |
| `off` | `untrusted`, read-only, user reviewer |
| `low` | `on-request`, workspace-write, user reviewer |
| `medium` | `on-request`, workspace-write, `auto_review` |
| `high` | `never`, danger-full-access, user reviewer |

Repeat approval/reviewer/sandbox/model/effort/service tier on every new turn.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/CodexProvider.ts` | `CodexDiscovery.ts`, `CodexDiscovery.test.ts` |
| `apps/server/src/provider/Layers/CodexAdapter.ts` | `CodexModes.ts`, `CodexModes.test.ts` |
| `apps/server/src/provider/Layers/codexLaunchArgs.ts` | `CodexExecutable.ts`, `CodexExecutable.test.ts` |

The paths above replace the earlier directory shorthand. Apply the mandated
source header to every mapped destination and add the same rows to
`sidecar/src/providers/codex/PROVENANCE.md` in this commit.

- [ ] **Step 1: Write failing POSIX/Windows executable, exact initialize,
      CLI/user-agent pair, rejection-fixture, pagination, redaction, retry,
      cleanup, and complete mapping tests**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/CodexExecutable.test.ts sidecar/src/providers/codex/CodexDiscovery.test.ts sidecar/src/providers/codex/CodexModes.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/codex/CodexExecutable.ts sidecar/src/providers/codex/CodexExecutable.test.ts sidecar/src/providers/codex/CodexDiscovery.ts sidecar/src/providers/codex/CodexDiscovery.test.ts sidecar/src/providers/codex/CodexModes.ts sidecar/src/providers/codex/CodexModes.test.ts sidecar/src/providers/codex/PROVENANCE.md
rtk git commit -m "feat(codex): discover supported app servers"
```

### Task C3: Run one isolated Codex session

**Files:**

- Create: `sidecar/src/providers/codex/CodexSession.ts`
- Create: `sidecar/src/providers/codex/CodexSession.test.ts`
- Create: `sidecar/src/providers/codex/CodexProviderAdapter.ts`
- Create: `sidecar/src/providers/codex/CodexProviderAdapter.test.ts`
- Modify: `sidecar/src/providers/codex/PROVENANCE.md`

Install all handlers before `initialize`. Create is initialize → initialized →
`thread/start`; resume strictly decodes `{threadId:string}` and uses
`thread/resume`. Missing history is a visible resume failure and never falls
back to `thread/start`. Expose returned `thread.id` and `{threadId}` to core;
only `SessionLifecycle` durably binds and activates the session. Later native
identity/resume changes emit `binding.updated` with opaque state for the
lifecycle's generation-checked compare-and-swap. The adapter never writes a
store.

`startTurn` consumes the exact captured `SessionConfiguration`, calls
`turn/start`, correlates native to the already-created canonical turn, and
resolves `Promise<void>` once accepted. Completion is emitted only as one
canonical `turn.settled`; a `startTurn` return value never settles a turn.
`steer` requires the live native pair and calls `turn/steer` without making a
second canonical turn. Interrupt uses the core-captured `turnId` and
`runtimeGeneration` and rejects a stale pair before native mutation. Close
settles interactions, invalidates writes, and terminates only its process tree
exactly once within the supplied absolute `ShutdownDeadline`.

Before activation, buffer at most 512 canonical events and 1,048,576 serialized
UTF-8 bytes. Test both count and byte overflow using multibyte input; either
overflow fails open, discards output, settles callbacks, and closes the process
tree.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | `CodexSession.ts`, `CodexSession.test.ts` |
| `apps/server/src/provider/Layers/CodexAdapter.ts` | `CodexProviderAdapter.ts`, `CodexProviderAdapter.test.ts` |

Apply the mandated source headers and add these exact rows to
`sidecar/src/providers/codex/PROVENANCE.md` in this commit. Port only what the
DROIDEX contract requires.

- [ ] **Step 1: Add failing initialization-order, create/resume, no-fallback,
      bounded-buffer, binding-update ownership, configuration acceptance,
      turn-correlation, genuine-steer, captured interrupt, deadline close,
      close-race, stale-event, crash-isolation, and exact-terminal-event tests**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/CodexSession.test.ts sidecar/src/providers/codex/CodexProviderAdapter.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/codex/CodexSession.ts sidecar/src/providers/codex/CodexSession.test.ts sidecar/src/providers/codex/CodexProviderAdapter.ts sidecar/src/providers/codex/CodexProviderAdapter.test.ts sidecar/src/providers/codex/PROVENANCE.md
rtk git commit -m "feat(codex): run isolated app-server sessions"
```

### Task C4: Normalize Codex events, approvals, and questions

**Files:**

- Create: `sidecar/src/providers/codex/CodexEvents.ts`
- Create: `sidecar/src/providers/codex/CodexEvents.test.ts`
- Create: `sidecar/src/providers/codex/CodexInteractions.ts`
- Create: `sidecar/src/providers/codex/CodexInteractions.test.ts`
- Create: `sidecar/src/providers/codex/fixtures/protocol/runtime-events.jsonl`
- Create: `sidecar/src/providers/codex/fixtures/protocol/server-requests.jsonl`
- Modify: `sidecar/src/providers/codex/CodexSession.ts`
- Modify: `sidecar/src/providers/codex/CodexSession.test.ts`
- Modify: `sidecar/src/providers/codex/CodexProviderAdapter.ts`
- Modify: `sidecar/src/providers/codex/CodexProviderAdapter.test.ts`
- Modify: `sidecar/src/providers/codex/PROVENANCE.md`

Normalize thread/turn lifecycle; agent text; reasoning/summary; command output;
file changes/diff; MCP/tool lifecycle; plans; token usage; retry warnings/fatal
errors; and explicit collab activity as observational only. Do not fabricate a
plan callback: advertise plan review only if the frozen protocol supplies it.

Support exactly:
`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, and `item/tool/requestUserInput`.
Translate once/session/deny to `accept`/`acceptForSession`/`decline`; all
terminal cancellation maps to `cancel`. Preserve native question IDs exactly;
advertise `multiSelect:false` for the frozen schema while preserving answer
arrays; answer with `{answers:{[id]:{answers:string[]}}}`; cancellation uses an
empty map. Unknown/malformed questions fail closed.

Return method-not-found for frozen `item/permissions/requestApproval` and
exclude versions that emit it in supported flows until designed/tested. Never
silently grant legacy patch/exec/token-refresh/attestation/dynamic callbacks.

Normalize native completion/error/cancellation into exactly one canonical
`turn.settled` event for the active captured generation. Text, plan, collab,
and task activity after that event is rejected; collab activity remains
observational and its detailed transcript remains suppressed.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/CodexAdapter.ts` | `CodexEvents.ts`, `CodexEvents.test.ts`, `CodexInteractions.ts`, `CodexInteractions.test.ts` |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | `CodexSession.ts`, `CodexSession.test.ts`, `CodexProviderAdapter.ts`, `CodexProviderAdapter.test.ts` |

Add any newly required source header and these exact rows to
`sidecar/src/providers/codex/PROVENANCE.md` in the same C4 commit.

- [ ] **Step 1: Add fixture tests for every normalized event, dedupe/order,
      every decision, exact question shape, cancellation, unsupported request,
      EOF/crash settlement, and observational transcript suppression. Include
      an integration assertion that native messages/requests traverse the live
      session and adapter into their canonical sinks.**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/CodexEvents.test.ts sidecar/src/providers/codex/CodexInteractions.test.ts sidecar/src/providers/codex/CodexSession.test.ts sidecar/src/providers/codex/CodexProviderAdapter.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/codex/CodexEvents.ts sidecar/src/providers/codex/CodexEvents.test.ts sidecar/src/providers/codex/CodexInteractions.ts sidecar/src/providers/codex/CodexInteractions.test.ts sidecar/src/providers/codex/CodexSession.ts sidecar/src/providers/codex/CodexSession.test.ts sidecar/src/providers/codex/CodexProviderAdapter.ts sidecar/src/providers/codex/CodexProviderAdapter.test.ts sidecar/src/providers/codex/PROVENANCE.md sidecar/src/providers/codex/fixtures/protocol/runtime-events.jsonl sidecar/src/providers/codex/fixtures/protocol/server-requests.jsonl
rtk git commit -m "feat(codex): normalize events and interactions"
```

### Task C5: Close Codex recovery and branch validation

**Files:**

- Create: `sidecar/src/providers/codex/CodexRecovery.test.ts`
- Create: `sidecar/src/providers/codex/CodexSmoke.test.ts`
- Create: `sidecar/src/providers/codex/smoke-codex-authenticated.mjs`
- Modify: `sidecar/src/providers/codex/CodexSession.ts`
- Modify: `sidecar/src/providers/codex/CodexEvents.ts`
- Modify: `sidecar/src/providers/codex/CodexInteractions.ts`
- Modify: `sidecar/src/providers/codex/PROVENANCE.md`

Complete interrupt/close/EOF/crash/replacement/shutdown settlement,
`serverRequest/resolved` correlation, supported skills/MCP fixture coverage,
and bounded child best-effort interrupts while always running root interrupt.
Emit sanitized observational provider-agent activity, while suppressing its
detailed transcript, child navigation, and addressable child controls. Add a
provider-local deterministic smoke against the fake executable and an opt-in
authenticated smoke script without changing shared registration.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | `CodexSession.ts` |
| `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts` | `CodexRecovery.test.ts`, `CodexSmoke.test.ts` |
| `apps/server/src/provider/Layers/CodexAdapter.ts` | `CodexEvents.ts`, `CodexInteractions.ts` |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts` | `CodexRecovery.test.ts`, `CodexSmoke.test.ts` |
| `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts` | `CodexRecovery.test.ts` |
| `apps/server/src/provider/Layers/CodexCollabWire.test.ts` | `CodexRecovery.test.ts` |

Every mapped destination adds every applicable source header and the exact row
to `sidecar/src/providers/codex/PROVENANCE.md` in the C5 commit. The smoke
script remains original DROIDEX code unless implementation actually derives it;
if it does, map and mark it in this same commit.

- [ ] **Step 1: Add failing recovery/smoke cases and implement them**
- [ ] **Step 2: Run the Codex branch gate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/codex/*.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run sidecar:build
rtk mise exec node@22 -- npm run quality:file-size
rtk git add sidecar/src/providers/codex/CodexRecovery.test.ts sidecar/src/providers/codex/CodexSmoke.test.ts sidecar/src/providers/codex/smoke-codex-authenticated.mjs sidecar/src/providers/codex/CodexSession.ts sidecar/src/providers/codex/CodexEvents.ts sidecar/src/providers/codex/CodexInteractions.ts sidecar/src/providers/codex/PROVENANCE.md
rtk git commit -m "test(codex): cover recovery and provider smoke"
```

---

## Claude branch

### Task A1: Pin the Claude SDK and prove packaged-runtime feasibility

**Files:**

- Modify: `sidecar/package.json`
- Modify: `sidecar/package-lock.json`
- Create: `sidecar/src/providers/claude/ClaudeExecutable.ts`
- Create: `sidecar/src/providers/claude/ClaudeExecutable.test.ts`
- Create: `sidecar/src/providers/claude/ClaudeDiscovery.ts`
- Create: `sidecar/src/providers/claude/ClaudeDiscovery.test.ts`
- Create: `sidecar/src/providers/claude/ClaudePackaging.test.ts`
- Create: `sidecar/src/providers/claude/PROVENANCE.md`

First verify that P0 contains an affirmative, authorized human Anthropic
use/redistribution decision. If it is absent or negative, mark Claude runtime
`BLOCKED` and make no dependency or runtime-code change. With approval, install
the SDK using exactly:

```bash
rtk mise exec node@22 -- npm install --prefix sidecar --save-exact @anthropic-ai/claude-agent-sdk@0.3.170
```

Add only peer dependencies that the clean install proves are required, pinned
exactly to reviewed versions. Do not upgrade DROIDEX's direct Zod 3 dependency
unless DROIDEX source imports Zod 4 in this same task; if a clean tree cannot
satisfy the SDK peer graph without that unauthorized upgrade, A1 is `BLOCKED`.
Do not use `--force`, `--legacy-peer-deps`, overrides, or a foreign lock entry.
Record SDK integrity only from the generated lock, then prove reproducibility
with the exact clean command `npm ci --prefix sidecar`.

Resolve a user-installed Claude executable across POSIX and Windows shims and
always pass the explicit real executable/Node entry to the SDK. Never replace
`HOME`; use `CLAUDE_CONFIG_DIR` only when explicitly configured. Never inspect,
log, relay, or persist credentials.

Probe version plus a disposable query with `persistSession:false`, no tools,
empty strict MCP, an unchanged copy of `process.env`, explicit executable, and
bounded abort. Preserve truthful DROIDEX-owned client identity; never spoof an
Anthropic/Claude first-party entrypoint, user agent, or client metadata. Await
initialization and read official model/command/skill/account APIs; emit only
sanitized auth/API-provider/billing labels.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Drivers/ClaudeExecutable.ts` | `ClaudeExecutable.ts` |
| `apps/server/src/provider/Drivers/ClaudeExecutable.test.ts` | `ClaudeExecutable.test.ts` |
| `apps/server/src/provider/Drivers/ClaudeHome.ts` | `ClaudeExecutable.ts`, `ClaudeDiscovery.ts` |
| `apps/server/src/provider/Drivers/ClaudeHome.test.ts` | `ClaudeExecutable.test.ts`, `ClaudeDiscovery.test.ts` |
| `apps/server/src/provider/Drivers/ClaudeSkills.ts` | `ClaudeDiscovery.ts` |
| `apps/server/src/provider/Drivers/ClaudeSkills.test.ts` | `ClaudeDiscovery.test.ts` |
| `apps/server/src/provider/Layers/ClaudeProvider.ts` | `ClaudeDiscovery.ts` |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts` | `ClaudeDiscovery.test.ts`, `ClaudePackaging.test.ts` |

Add every applicable header and these exact rows to
`sidecar/src/providers/claude/PROVENANCE.md` in A1.

The packaging feasibility test builds the sidecar and proves SDK JS/assets load
with an external fake executable while excluding every optional
`@anthropic-ai/claude-agent-sdk-<platform>` executable from the distributable.
The lock may describe npm's optional graph; no platform executable may enter
the packaged sidecar. If this
cannot work with the self-contained sidecar, stop before runtime implementation
and document the exact required non-CLI assets.

- [ ] **Step 1: Verify the recorded affirmative human legal go; stop if absent**
- [ ] **Step 2: Add failing executable, disposable-probe, identity, secret, and packaging tests**
- [ ] **Step 3: Run the exact SDK install, add only proven peers, then run clean `npm ci --prefix sidecar`**
- [ ] **Step 4: Implement discovery, run MCP
      regressions, and commit**

```bash
rtk mise exec node@22 -- npm ci --prefix sidecar
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/claude/ClaudeExecutable.test.ts sidecar/src/providers/claude/ClaudeDiscovery.test.ts sidecar/src/providers/claude/ClaudePackaging.test.ts sidecar/src/FactoryMcpConfig.test.ts sidecar/src/browser/browserMcpServer.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run sidecar:build
rtk git add sidecar/package.json sidecar/package-lock.json sidecar/src/providers/claude/ClaudeExecutable.ts sidecar/src/providers/claude/ClaudeExecutable.test.ts sidecar/src/providers/claude/ClaudeDiscovery.ts sidecar/src/providers/claude/ClaudeDiscovery.test.ts sidecar/src/providers/claude/ClaudePackaging.test.ts sidecar/src/providers/claude/PROVENANCE.md
rtk git commit -m "feat(claude): pin and discover the Agent SDK"
```

### Task A2: Map Claude modes, permissions, questions, and plan review

**Files:**

- Create: `sidecar/src/providers/claude/ClaudeModes.ts`
- Create: `sidecar/src/providers/claude/ClaudeModes.test.ts`
- Create: `sidecar/src/providers/claude/ClaudeInteractions.ts`
- Create: `sidecar/src/providers/claude/ClaudeInteractions.test.ts`
- Modify: `sidecar/src/providers/claude/PROVENANCE.md`

Use exact tool names. `off` uses no allowed tools and canonical approval for
every tool; `low` allows only exact `Read`, `Glob`, `Grep`; `medium` maps to
SDK `auto`; `high` maps to `bypassPermissions` plus the dangerous flag. Before
claiming `off`, conformance-test that every tested tool reaches `canUseTool`, or
disable it. `spec` uses `plan` for the next turn; `agi` is unsupported.
`AskUserQuestion` and `ExitPlanMode` remain special even in high mode.

Map approval once to allow with `updatedInput`; session to allow with the SDK’s
exact suggested `updatedPermissions`; deny without interrupt; cancel with
interrupt semantics. Always remove abort listeners/pending entries in
`finally` and settle once on terminal paths.

Question key is the full nonempty question text. Preserve `multiSelect`, reject
duplicate/empty text, never synthesize keys, preserve scalar vs array native
answers, and return original questions plus exact-keyed answers.

For ExitPlanMode, capture plan/tool-use ID, dedupe callback and assistant
snapshot copies, emit one nonblocking plan review, and immediately deny the
native request with a safe wait message. Implement changes the next mode to
auto and steers if live/new turn if idle; Iterate keeps spec and steers if
live/new plan turn if idle.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | `ClaudeModes.ts`, `ClaudeInteractions.ts` |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` | `ClaudeModes.test.ts`, `ClaudeInteractions.test.ts` |
| `apps/server/src/provider/Services/ClaudeAdapter.ts` | `ClaudeModes.ts`, `ClaudeInteractions.ts` |

The DROIDEX implementation stays plain TypeScript and session-owned. Add every
applicable header and these exact rows to `PROVENANCE.md` in A2.

- [ ] **Step 1: Add failing full table, conformance, every decision,
      abort/cleanup, exact-question, multiselect, plan-dedupe, implement, and
      iterate tests**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/claude/ClaudeModes.test.ts sidecar/src/providers/claude/ClaudeInteractions.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/claude/ClaudeModes.ts sidecar/src/providers/claude/ClaudeModes.test.ts sidecar/src/providers/claude/ClaudeInteractions.ts sidecar/src/providers/claude/ClaudeInteractions.test.ts sidecar/src/providers/claude/PROVENANCE.md
rtk git commit -m "feat(claude): enforce modes and interactions"
```

### Task A3: Run one strict resumable Claude Query session

**Files:**

- Create: `sidecar/src/providers/claude/ClaudeSession.ts`
- Create: `sidecar/src/providers/claude/ClaudeSession.test.ts`
- Create: `sidecar/src/providers/claude/ClaudeProviderAdapter.ts`
- Create: `sidecar/src/providers/claude/ClaudeProviderAdapter.test.ts`
- Create: `sidecar/src/providers/claude/fixtures/FakeClaudeQuery.ts`
- Modify: `sidecar/src/providers/claude/PROVENANCE.md`

One session owns one long-lived `Query` and open async prompt iterator. Fresh
create uses an injected provider UUID as SDK `sessionId` and persists. Strict
resume state is `{sessionId:string,assistantMessageId?:string}`; resume passes
`resume` and optional `resumeSessionAt`, never a new `sessionId`. Await
initialization/native confirmation; missing history or identity mismatch fails
without fresh-query fallback. Persist latest durable assistant UUID.

`startTurn` consumes the exact core-captured `SessionConfiguration`, enqueues
the message for the already-created canonical turn, and resolves
`Promise<void>` only after the Query accepts it. It never returns terminal
state: generation-checked `turn.settled` is the sole terminal authority. Active
steer enqueues a priority prompt into the same iterator and retains the turn.
Set mode/model only from that captured configuration before a new prompt.
Interrupt validates the core-captured `turnId` and `runtimeGeneration` before
mutation. Durable assistant cursors emit `binding.updated`; only
`SessionLifecycle` persists them. Close uses the supplied absolute
`ShutdownDeadline`, never a fresh relative window. The adapter writes no store.

Before activation, buffer at most 512 canonical events and 1,048,576 serialized
UTF-8 bytes. Count or multibyte byte overflow fails open, discards buffered
output, settles callbacks, and closes the Query before activation.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | `ClaudeSession.ts`, `ClaudeProviderAdapter.ts`, `fixtures/FakeClaudeQuery.ts` |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` | `ClaudeSession.test.ts`, `ClaudeProviderAdapter.test.ts`, `fixtures/FakeClaudeQuery.ts` |
| `apps/server/src/provider/Services/ClaudeAdapter.ts` | `ClaudeProviderAdapter.ts` |

Add every applicable header and these exact rows to `PROVENANCE.md` in A3.

- [ ] **Step 1: Add failing create/resume/no-fallback, binding cursor,
      captured-configuration acceptance, acceptance-only start, send/steer,
      captured-generation interrupt, preactivation limits, sole-terminal,
      absolute-deadline close, close/resume race, no-store-write, and cleanup tests**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/claude/ClaudeSession.test.ts sidecar/src/providers/claude/ClaudeProviderAdapter.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/claude/ClaudeSession.ts sidecar/src/providers/claude/ClaudeSession.test.ts sidecar/src/providers/claude/ClaudeProviderAdapter.ts sidecar/src/providers/claude/ClaudeProviderAdapter.test.ts sidecar/src/providers/claude/fixtures/FakeClaudeQuery.ts sidecar/src/providers/claude/PROVENANCE.md
rtk git commit -m "feat(claude): run resumable Query sessions"
```

### Task A4: Normalize Claude messages without duplicate output

**Files:**

- Create: `sidecar/src/providers/claude/ClaudeMessages.ts`
- Create: `sidecar/src/providers/claude/ClaudeMessages.test.ts`
- Create: `sidecar/src/providers/claude/fixtures/query-messages.jsonl`
- Modify: `sidecar/src/providers/claude/ClaudeSession.ts`
- Modify: `sidecar/src/providers/claude/ClaudeSession.test.ts`
- Modify: `sidecar/src/providers/claude/ClaudeProviderAdapter.ts`
- Modify: `sidecar/src/providers/claude/ClaudeProviderAdapter.test.ts`
- Modify: `sidecar/src/providers/claude/PROVENANCE.md`

Emit partial text/thinking once; snapshots only backfill absent content. Track
blocks by assistant message plus block index/tool-use ID; emit one start and
completion; accumulate JSON input deltas; match user tool results; force-close
remaining blocks on result; emit exactly one terminal only when a canonical
turn is active. Keep success/failed/interrupted/cancelled distinct, hide
`[ede_diagnostic]`, emit cursor changes only as `binding.updated` from durable
assistant messages, fail the captured generation on unexpected Query EOF,
clamp context to provider window, and
normalize structured TodoWrite/plan updates when present.

All paths retain the captured `SessionConfiguration`, `turnId`, and
`runtimeGeneration`; generation-checked `turn.settled` is the sole terminal
authority. Late output is rejected. The preactivation 512-event/1,048,576-byte
limits and absolute close deadline remain enforced, and no store is written.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | `ClaudeMessages.ts`, `ClaudeSession.ts`, `ClaudeProviderAdapter.ts`, `fixtures/query-messages.jsonl` |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` | `ClaudeMessages.test.ts`, `ClaudeSession.test.ts`, `ClaudeProviderAdapter.test.ts`, `fixtures/query-messages.jsonl` |
| `apps/server/src/provider/Services/ClaudeAdapter.ts` | `ClaudeMessages.ts`, `ClaudeProviderAdapter.ts` |

Add every applicable header and these exact rows to `PROVENANCE.md` in A4.

- [ ] **Step 1: Add failing partial/snapshot, thinking, tool, result, usage,
      cursor, EOF, diagnostic, ordering, and terminal-dedupe fixtures. Include
      an integration assertion that the live Query iterator reaches the
      canonical event sink through `ClaudeSession` and its adapter.**
- [ ] **Step 2: Implement, validate, and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/claude/ClaudeMessages.test.ts sidecar/src/providers/claude/ClaudeSession.test.ts sidecar/src/providers/claude/ClaudeProviderAdapter.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk git add sidecar/src/providers/claude/ClaudeMessages.ts sidecar/src/providers/claude/ClaudeMessages.test.ts sidecar/src/providers/claude/fixtures/query-messages.jsonl sidecar/src/providers/claude/ClaudeSession.ts sidecar/src/providers/claude/ClaudeSession.test.ts sidecar/src/providers/claude/ClaudeProviderAdapter.ts sidecar/src/providers/claude/ClaudeProviderAdapter.test.ts sidecar/src/providers/claude/PROVENANCE.md
rtk git commit -m "feat(claude): normalize Query messages"
```

### Task A5: Close Claude task/recovery behavior and branch validation

**Files:**

- Create: `sidecar/src/providers/claude/ClaudeRecovery.test.ts`
- Create: `sidecar/src/providers/claude/ClaudeSmoke.test.ts`
- Create: `sidecar/src/providers/claude/smoke-claude-authenticated.mjs`
- Modify: `sidecar/src/providers/claude/ClaudeSession.ts`
- Modify: `sidecar/src/providers/claude/ClaudeMessages.ts`
- Modify: `sidecar/src/providers/claude/ClaudeInteractions.ts`
- Modify: `sidecar/src/providers/claude/ClaudeDiscovery.ts`
- Modify: `sidecar/src/providers/claude/PROVENANCE.md`
- Modify: `sidecar/package.json`
- Modify: `sidecar/package-lock.json` only if a script/dependency actually changes

Normalize task started/progress/updated/notification as observational activity
only; never create a DROIDEX child without independent open/send/interrupt/
resume. Suppress subagent transcript from parent. Bound `stopTask` to 3 seconds
per task and 10 seconds total as maxima, each clamped to the time remaining on
the application's supplied absolute `ShutdownDeadline`. Task stopping gets no
extra window; root `Query.interrupt` always runs afterward if time remains. Settle
interaction maps on every terminal path. Add exact capability discovery for
skills/slash/MCP/images and a deterministic fake-executable smoke plus opt-in
authenticated smoke, without shared registration.

Recovery retains the captured `SessionConfiguration`, `turnId`, and
`runtimeGeneration`; `startTurn` remains acceptance-only `Promise<void>`, and
generation-checked `turn.settled` remains the sole terminal event. Cursor
replacement uses `binding.updated`, close uses the same absolute deadline,
preactivation limits remain active, and no provider path writes a store.

**Frozen T3 provenance map for this commit:**

| Exact T3 source at the frozen SHA | DROIDEX destinations |
| --- | --- |
| `apps/server/src/provider/Drivers/ClaudeSkills.ts` | `ClaudeDiscovery.ts` |
| `apps/server/src/provider/Drivers/ClaudeSkills.test.ts` | `ClaudeRecovery.test.ts`, `ClaudeSmoke.test.ts` |
| `apps/server/src/provider/Layers/ClaudeProvider.ts` | `ClaudeDiscovery.ts` |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts` | `ClaudeRecovery.test.ts`, `ClaudeSmoke.test.ts` |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | `ClaudeSession.ts`, `ClaudeMessages.ts`, `ClaudeInteractions.ts` |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` | `ClaudeRecovery.test.ts`, `ClaudeSmoke.test.ts` |
| `apps/server/src/provider/Services/ClaudeAdapter.ts` | `ClaudeSession.ts`, `ClaudeMessages.ts`, `ClaudeInteractions.ts` |

Add every applicable header and these exact rows to `PROVENANCE.md` in A5.

- [ ] **Step 1: Add failing task/recovery/capability/smoke tests and implement**
- [ ] **Step 2: Run the Claude branch gate and commit**

```bash
rtk mise exec node@22 -- node --import tsx --test sidecar/src/providers/claude/*.test.ts
rtk mise exec node@22 -- npm run sidecar:typecheck
rtk mise exec node@22 -- npm run sidecar:build
rtk mise exec node@22 -- npm run quality:file-size
rtk git add sidecar/src/providers/claude/ClaudeRecovery.test.ts sidecar/src/providers/claude/ClaudeSmoke.test.ts sidecar/src/providers/claude/smoke-claude-authenticated.mjs sidecar/src/providers/claude/ClaudeSession.ts sidecar/src/providers/claude/ClaudeMessages.ts sidecar/src/providers/claude/ClaudeInteractions.ts sidecar/src/providers/claude/ClaudeDiscovery.ts sidecar/src/providers/claude/PROVENANCE.md sidecar/package.json sidecar/package-lock.json
rtk git commit -m "test(claude): cover recovery and provider smoke"
```

## Adapter handoff

Each branch records its commit list, test output, exact native version, and any
authenticated smoke still pending. The integration owner reviews then merges
the commits without squashing. Shared registration and product UI happen only
in the convergence plan.

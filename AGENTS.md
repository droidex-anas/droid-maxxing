# Agent Instructions

DROIDEX is an Electron app: a React renderer in `src/`, an Electron host in
`electron/`, and a Node sidecar in `sidecar/src/` that drives the Factory Droid
SDK. Treat every change as production work that another strong engineer must
be able to read, review, debug, and change without reconstructing your
reasoning.

## Engineering priorities

Deliver the requested behavior with the smallest coherent solution: one clear
owner per concern, direct control flow, precise names, and no more concepts
than the problem needs. Smallest means fewest ideas, not fewest lines. Do not
preserve a broken design to keep a diff short, and do not compress readable
code to hit a limit.

Good code here is boring in the best way. A reader should be able to predict
what a function does from its name and signature, then confirm it in a glance.
If a reader has to mentally execute the code to know what it does, simplify it.

These are engineering defaults, not ceremony. Explicit user constraints and the
repository boundaries below always apply; beyond that, use judgment and explain
material tradeoffs in a sentence or two.

## Understand before editing

- Read the relevant implementation, its callers, the types it depends on, and
  the existing tests. Read `docs/architecture.md` when a change crosses the
  renderer, Electron, or sidecar boundary.
- Trace a bug to its owner and its actual cause. Do not patch a symptom with
  another flag, fallback, or special case.
- Search with `rg` for an existing helper, hook, selector, command, event, or
  type before adding one. Follow the established pattern where it fits; do not
  copy a known mistake because it is nearby.
- Use the repository's real scripts. Check `package.json`, `sidecar/package.json`,
  and `.github/workflows/` rather than inventing commands or adding a toolchain.
- Once the behavior and approach are clear, implement. Plan briefly for
  substantial or risky work; do not turn routine edits into architecture
  proposals or repeated approval requests.

## Implementation and reuse

- Keep related behavior together. Give mutable state one authoritative owner
  and derive other values from it instead of synchronizing copies.
- Prefer straightforward functions with explicit inputs and readable branches.
  Avoid dense one-liners, nested ternaries, misleading defaults, and indirect
  control flow.
- Extract a function or module when it names a meaningful operation, hides real
  complexity, owns an invariant or lifecycle, or removes duplication of the
  same rule. A good extraction can have a single caller.
- Do not extract merely to move lines elsewhere. No forwarding-only layers,
  context bags, catch-all `utils` files, or interfaces that add no boundary.
- Reuse existing code only when its meaning, ownership, and failure behavior
  match. Do not force unrelated workflows through one configurable helper
  because their syntax looks similar.
- Keep code feature-local until sharing is justified. Tolerate small incidental
  duplication rather than adding flags to a shared helper that then lies about
  what it does.
- Add dependencies, caches, registries, factories, and extension points only
  for a concrete, current need.
- No wrappers on wrappers. A function that only calls another function with
  the same arguments, a hook that only returns another hook, a component that
  only renders another component with the same props, or a type that only
  aliases another type is noise. Call the real thing.
- Make the fast path the plain path. Avoid work in render, avoid rebuilding
  derived values every call when a selector or memo is the natural owner, and
  do not copy large structures to change one field. Do not add memoization or
  indirection without a measured reason.
- Prefer early returns to nested conditions, flat data to deep option objects,
  and a small discriminated union to a bag of booleans.
- Delete what you supersede. Leave no dead exports, unused props, commented-out
  code, or stale comments behind your change.

## Leave it cleaner

When you work in existing code, clean the part you touch. The goal is that the
next reader cannot tell which lines were old and which were new, because both
now read the same way.

- Fix what your change exposes: a misleading name, a duplicated rule, a stale
  comment, a redundant branch, an unused parameter, a wrapper that no longer
  earns its place. Do it in the same diff when it is local and small.
- Do not stop at your own lines. If your change makes a helper's remaining
  callers obvious to fold in, fold them in; if it leaves a helper with one
  trivial caller, inline it.
- Stay inside the task's blast radius. Cleanup that reaches unrelated modules,
  reformats files, or renames widely used concepts is a separate change. Note
  it for later instead of doing it now.
- Slop patterns to remove on sight when local: `x ?? x`, defensive checks for
  states the types already exclude, `try/catch` that only rethrows or logs,
  boolean parameters that select between two unrelated behaviors, `Props`
  spread through three layers, `TODO` without an owner, and `// eslint-disable`
  without a reason.

## File size

Line count is a signal to inspect responsibilities, not a design goal.

- Leaf UI files usually sit around 50-250 lines; feature modules, hooks,
  reducers, and screens around 150-400.
- Do not create a production file above 500 lines, take a file across 500, or
  materially grow one already above it without stopping for review. Justify the
  exception: the file's single responsibility, why a split would hurt ownership
  or readability, and the reviewed ceiling.
- Existing oversized files are debt. Extract a cohesive responsibility only when
  it belongs to the current task.

Prefer a few focused modules over either a monolith or a maze of tiny files.

## Naming

A name should communicate the concept at the scope where it is read.

- Use the domain vocabulary consistently: nouns for values, verbs for
  operations, predicates for booleans (`isReady`, `canInterrupt`).
- Be specific without repeating context the module or type already supplies.
  `sessions.get(appSessionId)`, not `sessions.getSessionFromSessions(...)`.
- Include units where ambiguity matters (`timeoutMs`, `budgetBytes`).
  Distinguish identities from lifecycle states even when a shorter name is
  convenient.
- No unexplained abbreviations, no vague `data` / `info` / `manager` where the
  domain matters, and no decorative qualifiers like `new`, `enhanced`, or `v2`
  without a real versioned contract.
- Follow local conventions. Do not rename unrelated code for consistency.

## Comments and documentation

- Comments are sparse, short, and explain why, not what. One or two lines.
- Document non-obvious invariants, edge cases, compatibility constraints, and
  deliberate tradeoffs. Do not narrate the implementation, add section banners,
  or restate names and types in prose.
- Prefer a clearer name or simpler code over an explanatory comment. Small
  private helpers need no docblock.
- Document public contracts and genuinely intricate behavior when callers need
  it. Avoid essay-style TSDoc.
- Update comments and docs that your change affects. Do not create documents
  that merely summarize your work.

## Types, boundaries, and failures

- Represent valid states directly: precise types, discriminated unions, and
  exhaustive handling where it helps. Avoid optional-field combinations that
  permit contradictory states.
- Validate untrusted data at real boundaries: IPC, the bridge protocol,
  provider responses, persisted state, and user input. Past that boundary, trust
  the established contract instead of revalidating everywhere.
- Do not silence a missing invariant with `any`, a non-null assertion, a broad
  cast, or a fabricated default. Keep necessary assertions narrow and local.
- Handle failures that can actually happen. Catch where recovery or useful
  context belongs, use `finally` for owned cleanup, and otherwise let the
  responsible handler receive the error. Never swallow errors silently or log
  the same failure at every layer.
- Distinguish expected cancellation from failure. Make diagnostics actionable
  without exposing credentials or payloads.

## React and UI

- Keep the renderer provider-neutral. Translate SDK-specific types and behavior
  at the bridge boundary, not in presentation components. Preserve meaningful
  provider differences instead of pretending providers are identical.
- Keep feature state near its owner. Use the root store only for genuinely
  shared state, and pass focused values and callbacks rather than whole state
  objects.
- Derive presentation values during render or through selectors. Use effects
  for external synchronization only, with complete cleanup.
- Reuse existing components, theme tokens (`--droid-*`), and interaction
  patterns. Do not introduce a parallel palette or design system.
- Controls must be working, discoverable, and keyboard-accessible, with loading,
  empty, and error states. Polish does not replace function.
- Large lists mount only what is visible. Measure render cost with the real
  catalog or transcript before shipping a list-shaped change.

## DROIDEX identity and runtime contracts

Preserve these distinctions when touching sessions, providers, or async work:

- `appSessionId`: stable top-level DROIDEX session identity.
- `parentAppSessionId`: owning top-level identity for a child.
- `childSessionId`: stable logical child identity within its parent.
- `providerSessionId`: replaceable backend identity, never the UI identity.
- `session`: universal runtime and UI concept; `mission`: AGI Mission Control
  behavior only.
- `auto`, `spec`, `agi`: interaction modes. `off`, `low`, `medium`, `high`:
  independent autonomy levels.

Workers and validators are parent-owned child sessions, not top-level
navigation sessions. Change cross-process protocol definitions and all of their
consumers in the same commit.

For work that can race session closure, replacement, or shutdown: capture the
stable identity and generation before starting, revalidate after every await
before applying results, invalidate stale work before awaiting external cleanup,
and make settlement and cleanup idempotent. Release owned timers,
subscriptions, queues, waiters, and provisional resources. Stale results must
never mutate a replacement session.

## Compatibility policy

Maintain one canonical current implementation. Historical compatibility is
opt-in, never assumed.

Do not add legacy readers, migration paths, aliases, dual commands, fallback
fields, or shims unless the user explicitly asks to support the old contract.
Remove superseded paths within the scope of the replacement. Any approved
temporary compatibility path needs a stated supported case and a removal
condition.

Adapters for currently supported providers and recovery from real current
failures are not compatibility debt. This policy never authorizes discarding
user data or breaking a supported integration; establish that something is
obsolete before removing it, and surface a destructive transition instead of
assuming permission.

## Verification and tests

Verify the change. Tests are one way to do that, not a requirement for every
edit. Spend your attention on reading and understanding the code first; choose
checks by the uncertainty and failure risk they actually resolve, never by test
count, coverage targets, or a wish to look thorough.

- Start from existing coverage and focused checks. No new tests is a valid and
  common outcome. Renames, mechanical refactors, styling, and documentation
  changes usually need none.
- For UI changes, look at the rendered behavior in the running app when you
  can. A passing build is not visual verification.
- Add or update a durable test only when it protects meaningful behavior,
  closes a real gap, or would catch a plausible regression. A nontrivial bug
  gets one focused regression test at the narrowest level that reproduces it,
  not a test for every helper it touched.
- Prioritize deterministic coverage for data integrity, session targeting,
  ordering, cancellation, cleanup, security boundaries, and cross-process
  contracts. Exercise behavior through production entry points.
- Keep tests readable and small. No assertions that mirror implementation
  details, mock-only behavior, giant snapshots, redundant case matrices, or
  source-text checks unless the text is the contract. Use controlled promises,
  clocks, and faithful fakes for races, never sleeps.
- Extend an existing suite when the behavior belongs there. Do not add a test
  framework, expose private helpers, or add production indirection to make
  something testable.
- Write as many throwaway tests, probes, and reproduction scripts as you need
  while working; they are tools, not deliverables. Before committing, keep only
  the tests whose ongoing protection is worth their maintenance and delete the
  rest. Never commit scaffolding to look thorough, and never drop a valuable
  test to look small.
- Do not weaken assertions or delete failing tests to get a green run. Honor CI
  gates, including the coverage thresholds in `npm run test:coverage`.

Tests are maintained code too. Keep the ones whose protection justifies their
cost.

## Scope, Git, and delivery

- Inspect the branch and worktree before editing. Preserve unrelated user
  changes and the intended base. Use a separate worktree when isolation helps,
  not as a ritual, and do not switch to `origin/main` on your own.
- Never reset, clean, stash, rebase, overwrite, or broadly reformat a dirty
  checkout without permission. Do not infer authorization for pushes, PRs,
  merges, releases, destructive migrations, or authenticated external actions.
- Include local refactoring when the requested change needs it to be correct
  and maintainable. Keep unrelated redesigns, dependency upgrades, and
  formatting out of the diff.
- Keep commits focused, buildable, and honestly named. Plain commit messages,
  no generated trailers.
- Keep the diff reviewable. Every hunk should trace to the task or to cleanup
  the task exposed. No unrelated reformatting, import reordering, whitespace
  churn, or renames that widen the review without changing behavior. If a
  formatter touches lines you did not mean to change, revert them.
- Separate mechanical moves from behavior changes when both are large. A
  reviewer should never have to find a logic change inside a 400-line rename.
- Read your own diff before pushing as if reviewing a stranger's PR. If a hunk
  needs a comment to justify itself, either simplify it or explain it in the
  commit message, not in a code comment.
- Remove superseded code and your own temporary artifacts. Do not commit
  internal prompts, plans, reviewer transcripts, generated reports, or scratch
  files unless they are an explicit deliverable.
- Review the final diff for correctness, avoidable complexity, naming drift,
  duplicated rules, missing cleanup, and accidental scope. Passing tests are
  evidence, not understanding.
- Finish with a concise account of the result, the checks actually run and
  their outcomes, and remaining risks or manual verification. Never claim a
  check passed unless it was exercised.

The work is complete when the requested behavior is implemented coherently,
relevant verification supports it, and the change reads well without a long
defense of its design.

## Fast start

Use Node.js 22.

```bash
npm install
npm ci --prefix sidecar
npm run dev
```

For the full desktop app:

```bash
npm run electron
```

To run a second instance beside your main one, set `ELECTRON_START_URL` to a
different port and `DROIDEX_USER_DATA_DIR` to a separate profile directory.

## Required validation

Run the checks that match the files you changed. For broad changes:

```bash
npm run format:check
npm run typecheck
npm run sidecar:typecheck
npm run electron:check
npm run test
npm --prefix sidecar run test
npm run docs:check
npm run build
```

`npm run lint` is non-blocking because of existing backlog; new and changed
files still own their diagnostics. The pre-commit hook runs lint-staged, file
size, tech-debt, and typecheck gates.

Performance changes are validated with the deterministic replay harness
(`npm run perf:replay -- --scenario <smoke|idle|streaming|multi-agent|agents-4|agents-16|agents-27|long-history|long-tail|session-switch|soak>`),
not intuition; artifacts land in `reports/perf/`. Compare against `origin/main`
with `npm run perf:compare` and `npm run perf:report`, and enforce invariants
with `npm run perf:gates`. Bundle budgets are `npm run quality:bundle-budgets`.

## Project map

- `src/`: React UI, store, hooks, and frontend tests
- `electron/`: Electron main process, preload scripts, and launcher
- `sidecar/src/`: bridge, Factory runtime, browser runtime, and sidecar tests
- `docs/`: architecture, generated reference, and runbooks
- `tools/`: maintenance and validation scripts

## Environment variables

Start from `.env.example` for local overrides.

- `ELECTRON_START_URL`: Electron development URL
- `BRIDGE_PORT`: local sidecar WebSocket port
- `BRIDGE_TOKEN`: packaged Electron bridge token
- `DROIDEX_USER_DATA_DIR`: Electron profile directory override so a second dev
  instance can run beside the main one; its sidecar gets an isolated history
  state dir (`<profile>/history`) instead of competing for the shared writer
  lease
- `DROIDEX_HISTORY_DIR`: explicit history state directory for a bare sidecar
  running beside the main app
- `DROID_PATH`: explicit Droid CLI path
- `FACTORY_API_KEY`: optional Factory key for Droid child processes

## Secrets

Never commit, print, or paste secrets, tokens, personal data, or authenticated
payloads. That includes echoing `~/.factory/settings.json`, which contains
provider API keys.

## Documentation upkeep

When scripts, environment variables, or onboarding commands change:

```bash
npm run docs:generate
npm run docs:check
```

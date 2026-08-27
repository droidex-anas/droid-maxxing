# Performance budgets

These are the supported DROIDEX performance budgets after the phase 0–4
instrumentation and conversation virtualization work. They are hardware- and
profile-aware where the measurement allows it, and they do not claim precision
the harness cannot produce.

Two classes of number exist. Mixing them is a reporting failure.

- **A/B-measurable** — the same probe runs on `origin/main` and on this branch
  using APIs both refs have (bundle bytes, mounted rows, Markdown render,
  feed projection via `buildGroupedFeed` or the production projector,
  terminal deliveries per PTY flood).
- **Candidate-only** — requires the ordered event pipeline, replay harness,
  write-behind persistence, or virtualizer internals that `origin/main` lacks.
  Report as an absolute against a budget. Never as a delta versus main.

## How to measure

```bash
npm run perf:compare -- --baseline origin/main
npm run perf:report
npm run perf:gates
npm run quality:bundle-budgets
```

`perf:compare` uses a git worktree of the baseline ref and this branch’s
probes against that tree’s own production modules. Baseline probe output is
cached in `sidecar/src/perf/baselines/origin-main.json` with the measured
commit. A SHA mismatch is a stale cache, not a silent reuse.

Timing CPU and RSS from a shared CI runner are recorded and **warned**, never
failed. Promote a timing metric to a hard gate only after variance on
dedicated hardware is understood.

## Hard gates (deterministic)

| Invariant | Budget | Justification |
| --- | --- | --- |
| Mounted conversation rows for a 10k-row history | 80 rows | `conversationList.test.ts` keeps 3k and 10k histories under 80 mounted rows at a 900px viewport, 96px estimate, overscan 8. |
| Row visits per streamed tail token at 10k | 80 rows | Same mounted window: a tail delta must not visit retained history. |
| Visible events rebuilt per tail delta | 8 events | Incremental projection rebuilds the live tail. 8 is 4× a two-event append. |
| Renderer deliveries for 1000×64-byte PTY chunks | 16 messages | 64 KiB of PTY data at a 32 KiB MessagePort flush is a handful of posts; 16 is ~4× that plus replay. |
| Tool-marker event loss | 0 | Markers are uncoalesced. A completed replay must deliver every call/result pair. |
| Bridge sequence / order errors | 0 | The replay client rejects generation changes and sequence gaps; a finished report is zero errors. |
| Transport pending events high-water | 4096 | Product cap of the 4096-batch replay buffer. |
| Transport pending estimated bytes | 32 MiB | Product cap of the replay buffer. |
| Persistence overflow on a normal replay | 0 failures | Write-behind is capped at 50k rows / 64 MiB; overflow is explicit, not unbounded growth. |
| Live primary sessions after soak cleanup | 0 | 12 create/close cycles must release every session. |
| Initial renderer JS | 1_280_000 bytes | `tools/check-bundle-budgets.mjs`, measured post-split with modest headroom. |
| Initial CSS | 95_000 bytes | Same bundle check. |
| Largest lazy JS chunk | 680_000 bytes | Same bundle check. |

## Timing (warn, not CI-fail)

The #115 contract still stands as a product target, not a shared-runner gate:

| Experience | Target | Caveat |
| --- | --- | --- |
| Composer / first interactive input | Feels ready with the shell; no workspace-engine tax on first paint | Startup phase marks in `rendererPerf` are environment-specific. |
| Event-to-paint p95, ordinary streaming | Roughly 1–3 frames (16–50 ms) | Needs a real renderer paint; sidecar replay only measures append→WS receive. |
| Ordinary live output long tasks | Avoid >50 ms | `PerformanceObserver` longtask, renderer-only. |
| Long-session switch | Should not scale with full history size | Sidecar `session-switch` exercises `session.loadHistory` while streams run; renderer switch latency is not this number. |
| Memory plateau | Live resource count, not session duration | Soak checks session leaks. RSS on CI is noisy. |
| Hidden / minimized CPU | Approach idle aside from work that is still running | Needs a real Electron window. Not measured headless. |

Sidecar stage calibration (still `--enforce-budgets`, not CI-hard): normalize p95 2 ms, persist p95 10 ms, durability boundary p95 25 ms, emit p95 15 ms, transport fan-out p95 5 ms, append-to-client p95 = coalesce window + 20 ms, marker provider-to-client p95 50 ms, event-loop delay p95 25 ms.

## Hardware / profile

Numbers in committed comparison artifacts were gathered on the machine named
in the report’s `environment` block (Node version, platform, CPU count). They
are comparable across PRs on the **same** class of host. Do not treat a cloud
runner RSS or CPU delta as a product regression.

Reference viewport for the mounted-row budget: 720×900 CSS pixels, the
virtualizer’s `CONVERSATION_LIST_INITIAL_RECT`. A larger window mounts more
rows linearly with viewport height plus overscan; the 80-row budget assumes
that reference, not a 4K fullscreen session.

## Skipped workloads

- **browser/design workspace + model stream** — needs GUI.
- **hidden/minimized app with background agents** — needs a real window.
- **sidecar restart/reconnect** — owned by the concurrent supervision phase.

## Report shape

`npm run perf:report` writes a human- and machine-readable comparison to
`reports/perf/compare.md` (and `compare.json`). A/B rows have baseline,
candidate, and delta. Candidate-only rows have an absolute and no delta.

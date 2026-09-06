# Architecture

DROIDEX is split into three runtime surfaces: the React renderer, the Electron host, and the Node sidecar. Dedicated Node worker threads isolate high-frequency history persistence, provider-file reconciliation, transcript parsing, and full-text indexing from agent orchestration.

## Runtime flow

```mermaid
flowchart LR
  User[User] --> Renderer[React renderer]
  Renderer --> Preload[Electron preload API]
  Preload --> Main[Electron main process]
  Main --> Sidecar[Node sidecar WebSocket bridge]
  Sidecar --> DroidSDK[Factory Droid SDK]
  Sidecar --> DroidCLI[Droid CLI child processes]
  Sidecar --> HistoryWriter[History persistence worker]
  Sidecar --> HistorySearch[History search worker]
  HistoryWriter --> CanonicalHistory[(Canonical SQLite history)]
  HistorySearch --> SessionFiles[(Provider transcript files)]
  HistorySearch --> CanonicalHistory
  HistorySearch --> SearchCache[(Derived SQLite FTS5 cache)]
  Main --> Updater[Download and update endpoints]
```

## Components

| Area | Path | Responsibility |
| --- | --- | --- |
| Renderer | `src/` | React UI, local state, settings, onboarding, session and Mission Control views |
| Electron main | `electron/main.cjs` | Window lifecycle, bridge process management, native browser lifecycle, downloads, update checks |
| Electron preload | `electron/preload.cjs` | Narrow API boundary between renderer and Electron main process |
| Native browser preload | `electron/nativeBrowserPreload.cjs` | Browser automation bridge for embedded native browser flows |
| Sidecar | `sidecar/src/` | Local WebSocket bridge, Droid SDK session lifecycle, Mission Control integration, CLI discovery |
| History worker threads | `sidecar/src/historyPersistenceWorker.ts` | Independently supervised writer and index workers for batched durability, file reconciliation, transcript extraction, and SQLite FTS away from the sidecar event loop |

## Data and control boundaries

- The renderer does not call the Droid SDK directly. It communicates through preload APIs and the sidecar bridge.
- The Electron main process owns local process lifecycle and injects bridge configuration into the sidecar.
- The sidecar owns Droid SDK calls and child process environment shaping. It removes `FACTORY_API_KEY` unless a key is explicitly configured.
- Live canonical session state stays in the sidecar. A bounded write-behind queue sends lossless event rows and latest-wins summary/child snapshots to the history worker in ordered transactions.
- Packaged builds require a bridge token. Development builds may allow local no-token access with `BRIDGE_ALLOW_LOCAL_NO_TOKEN=1`.

### Native browser boundary

- Electron owns one persistent `persist:droidex-browser` partition shared by the built-in browser across DROIDEX chats. Sidecar browser sessions retain separate `appSessionId` and `browserSessionId` identities for routing and lifecycle; they do not own separate cookie profiles. Active task views stay in the hidden native host when another chat is visible, so background browser work does not replace the active task's pane. Idle hidden views are subject to the native browser budget: eviction retains only URL, viewport, and scroll state, never an unmasked screenshot. Agent actions, navigation, captures, and restores pin their view until settlement. Eviction revalidates the exact view, document, and usage generation before closing.
- Agent-supplied navigation accepts only external `http:` and `https:` URLs. `about:blank` is reserved for the internal initial state. Local files, executable `javascript:` or `data:` URLs, browser-internal pages, embedded URL credentials, and custom schemes are rejected before native navigation.
- Every native browser result is correlated by `requestId`, `appSessionId`, and `browserSessionId`. Actions for one managed browser are serialized. Close invalidates active and queued work before native cleanup; a replacement receives a fresh browser identity, so late results cannot update or reuse it.
- Settings → Browser is the user-owned policy surface. The Electron main process validates the full `requestId + appSessionId + browserSessionId + action + autonomy` request and executes it as one transaction. “Follow autonomy” resolves High to full safe-site access, Medium to exact-origin approval for new sites, and Low/Off to per-opening approval. The reserved first-party `droidex-browser` MCP server defers its generic SDK confirmation to this resource-owner policy, avoiding a second broad prompt on every hover or click. Direct address-bar, reload, and viewport actions retain explicit user provenance; agent redirects and delayed navigations remain main-process gated. Inspect, network, and console diagnostics stay behind a separate switch that is off by default; agents never receive raw CDP access.
- Cookie import is main-process owned. On macOS, Electron discovers Chrome profiles, asks in DROIDEX before invoking the fixed Keychain lookup for Chrome Safe Storage, opens the current cookie database read-only, validates Chromium v24 host hashes and cookie fields, and retains values only in an opaque, expiring, single-use plan. The renderer receives a random plan ID plus domain/count/replacement metadata. Bounded JSON/Netscape files are accepted only as Chrome recovery. Commit closes all native browser views before mutating the shared cookie store and flushes completed writes before the user reopens a site. After a successful or partial commit, browser settings persist only a receipt timestamp, Chrome method/profile label, and aggregate imported/replacement/skipped/failed/domain counts; domains, cookie names, values, and file paths are excluded by schema. Import remains cookie-only and deliberately skips partitioned cookies that Electron cannot represent; it does not clone local storage, service workers, device-bound state, or the rest of a Chrome profile. Safari live-session import is intentionally unavailable because Safari exposes no supported cookie-transfer API, so Safari accounts are signed in directly inside DROIDEX without a file picker or Full Disk Access request. No path imports browser passwords, and cookie values never cross into the React renderer or sidecar agent.
- Credentials are captured only from the known main frame of a native browser page after the user submits an unambiguous current-password or new-password form and accepts a save prompt. Electron encrypts and decrypts the credential through non-blocking operating-system protected storage (macOS Keychain on macOS), keys it by exact HTTPS origin (with an explicit loopback development exception), and revalidates the owning view, live contents, and origin before save or fill. An expected same-view navigation within the submitted origin does not discard the capture; replacement, destruction, or an origin change does. Every agent fill requires native approval by default; when macOS exposes Touch ID, DROIDEX asks for it immediately before decrypting and injecting. Plaintext credentials are never returned to the renderer or agent.
- Agent-triggered signup, sign-in, OAuth, and detected passkey actions require a single-use native approval before the click or submit is sent. Cross-origin iframe authentication fails closed at every autonomy level. OAuth can mint one short-lived, one-use capability only when the exact inspected provider destination is authoritatively known; a different or unresolved popup target is denied. Passkey actions never mint a web-popup capability. The sandboxed OAuth child shares the DROIDEX partition for provider compatibility, retains its opener relationship, blocks unsafe schemes and further popups, and is not connected to the agent automation bridge.
- On supported Electron/macOS releases, WebAuthn account selection is owned by the main process and cancels by default. The native prompt receives only sanitized account labels, while credential IDs remain in main-process memory and only the chosen opaque ID is returned to Chromium. Touch ID WebAuthn is configured only for packaged Developer ID releases carrying the concrete `${APPLE_TEAM_ID}.app.droidex.webauthn` keychain access group. Release packaging fails when that Team ID is absent or malformed; development and ad-hoc packages report Touch ID passkeys as unavailable. These passkeys are device-bound, and DROIDEX does not claim iCloud Passwords synchronization.
- Arbitrary remote pages run with Chromium sandboxing, context isolation, and Node integration disabled. Agent-facing URLs redact OAuth codes, state, nonce, SAML assertions, tickets, fragments, and other token-like parameters. Screenshot capture masks password and one-time-code inputs. A remote page cannot settle an agent request; only the authoritative main-process invoke result can.
- Camera and microphone are blocked by default. Ask mode routes the exact top-level origin and media types through a correlated, abortable DROIDEX prompt. Allow once lasts for the current document; Block once denies only the current request. Always-allow and always-block decisions are persisted per exact origin and media type and remain revocable in Settings. The permission check handler denies before a valid grant exists. macOS TCC remains the final required system boundary. USB, HID, serial, and other device permissions remain denied. Downloads show a save dialog by default; automatic paths are constrained to the configured download directory with sanitized, non-overwriting names.
- The optional DROIDEX agent cursor is a sandboxed, transparent, click-through child window positioned above the native browser at the isolated preload's resolved click, hover, and scroll coordinates. Its curved pointer uses DROIDEX translucency, a soft blue activity halo, a subtle reduced-motion-aware working rock, and a controller-owned ease-in-out glide between consecutive live points; light and dark treatments plus a bounded 24–64 px artwork-size control are available in Settings. Dedicated transparent padding prevents the outline and halo from being clipped, while the native hotspot scales with the artwork so the visible tip remains the actual input point. The cursor is an automatic side effect of the normal browser action, not another model tool call. Each browser session retains its last completed point while its pane is hidden, so returning to a task restores the pointer without redirecting or reloading the page. A visible native pointer action is refused unless the overlay can represent the same in-bounds point. Remote pages cannot call, remove, or hide the native overlay (although page content can imitate cursor artwork, so the indicator is telemetry rather than an authentication signal). Only a focused DROIDEX browser pane displays it; background task views continue independently in the hidden native host without raising DROIDEX, activating the app, or switching the user's current task.
- `nativeBrowser` owns the browser registry and composes focused view, layout, navigation, action, capture, credential, eviction, and recovery owners. Only renderer layout commands attach or detach a pane; agent actions never carry attachment bounds. Pending attachment and crash recovery use layout revisions so a switched pane cannot be reclaimed by stale work. Page-originated IPC is main-frame-only, and design prompt capture revalidates the owning view and document before forwarding.
- The live native `WebContents` URL is authoritative. Manual navigations publish into renderer state, `snapshot` observes without navigating, and tool guidance forbids reopening conversation-memory URLs for current-page inspection. Reload prefers a valid live URL, then the last valid failed/loading/target URL, then the configured home page; `about:blank` and Chromium error documents never replace recoverable page state.
- Browser element refs are leased to the exact isolated document snapshot that produced them. Navigation invalidates the lease and cancels any pointer action still waiting on cursor motion, so a compacted or delayed turn cannot apply an old ref to replacement content. Click and scroll run in the isolated preload after the native cursor reaches the validated live point. Hover validates the same document/ref/point, then uses Chromium's mouse-move command so CSS hover menus work without focusing the host window. Debugger work is serialized and revalidated when its queue turn begins; native hover events cannot mint user-navigation approval during an agent action. Scrolling resolves the current nearest scrollable ancestor instead of replaying a cached box, waits for layout settlement, and reports movement versus a reached boundary with the fresh snapshot.
- Clearing browser data closes native browser views, then removes cookies, cache, local storage, IndexedDB, service workers, cache storage, and HTTP authentication state from the shared partition. Saved DROIDEX logins are managed separately and can be deleted per origin.

### Sidecar session core

- `appSessionId` is the stable top-level application identity. `childSessionId` is the stable logical child identity within its `parentAppSessionId`; `providerSessionId` is reserved for the backing Factory session.
- `SessionManager` is the composition root and public command coordinator. It retains public dispatch, cross-module routing, and shutdown ordering.
- `FactoryRuntime` is the narrow SDK seam; `DroidRuntime` is its production adapter.
- `SessionRegistry` owns top-level sessions only: the live parent map, stable application identity, provider aliases, canonical parent summary persistence, and projected summary reads. Children never enter `SessionRegistry` or `sessions.list`.
- Ordinary chats enter durable `sessions.list` history only after the provider file contains both a user message and an assistant response. In-progress first turns remain visible through the live registry; abandoned or unanswered provider files never become permanent sidebar rows.
- `ChildSessions` is the one stateful generic owner of parent-child membership, canonical child identity, provider replacement, admission, capacity, queues, turns, settings, cleanup, exact context/compaction targets, and child persistence/hydration.
- `MissionControlPolicy` owns only AGI Mission Control policy and projection: features, progress, worker/validator decisions, spawn correlation, Mission phase, and Mission completion. It may call `ChildSessions`; `ChildSessions` does not import Mission Control.
- `SessionTimeline` owns history listing and restore, child replay, status entries, and the canonical record-before-emit path for live transcript events.
- `SessionContext` owns context snapshots, polling, compaction generations, and usage carryover. Parent and child targets remain isolated by `appSessionId` or the exact `parentAppSessionId + childSessionId` pair.
- Task children keep the custom-agent label and the effective model/reasoning from that exact provider-session launch as separate metadata. The renderer never derives a child model from its label or parent session; stable child IDs remain available in row diagnostics when labels repeat.
- `SessionCompaction` owns compaction-limit policy, provider arming, automatic notification transitions and watchdogs, and live or historical manual compaction. Child automatic settlements validate the captured parent, runtime, turn, and configuration generations before publishing or mutating state.
- `SessionInteractions` owns permission and question correlation, equivalent-signature grants, and the Spec-to-Auto transition. After successful Registry unregister, Lifecycle calls `forgetSession()`, which discards module-owned state without resolving callbacks or emitting events. PR 4 introduces no deterministic shutdown settlement; that behavior remains deferred.
- `SessionEventFlow` owns stream and notification normalization, per-app/per-source terminal gating, and transcript-before-side-effect ordering. It has one callback into Manager for the coupled policy that remains there.
- `SessionLifecycle` owns primary-session create, resume, lazy resume, send queueing, steering, interruption, and ordered cleanup. Parent close calls one semantic `ChildSessions.closeParent()` operation rather than maintaining another child map.
- Workspace sessions pass their selected folder to Factory unchanged. Folder-less sessions remain `workspaceKind: none` in navigation, while their Factory runtime uses the app-owned `chats/` directory under `DROIDEX_USER_DATA_DIR`; DROIDEX creates it before opening the session and never uses the user's home directory as an implicit workspace.

### Child runtime residency

- Every live child runtime is a provider operating-system process. One measures roughly 350 MiB resident while doing nothing, so the four concurrently live child runtimes the budget allows are the largest single memory cost in the application.
- `childRuntimeBudget` decides admission and which idle runtime is evicted under pressure. `childRuntimeRetirement` decides when a runtime may be released with no pressure at all, and `ChildSessions` owns both timers and the close itself.
- A runtime is released after `CHILD_RUNTIME_IDLE_RETIREMENT_MS` (5 minutes) without use, and only once the child is fully settled: the parent no longer reports it running, no turn is streaming, nothing is queued or compacting, no interrupt or steer is in flight, no mutation is pending, no open attempt is outstanding, and the last result has reached history. A child doing work is never retired, however long its runtime has sat unused.
- Retirement closes the provider process only. The child, its persisted transcript, and its history survive. Opening it again paints history first and then reloads the provider session, and the child's transcript records why its runtime went away.
- The wake-up is a single timer armed for the earliest deadline and only while some runtime is actually retirable, so an app with nothing idle has no timer at all.

### Session runtime residency

- A top-level session's provider runtime is the same kind of operating-system process, roughly 355 MiB and 17 threads. A user working across several workspaces holds one per open session for the whole app run.
- `sessionRuntimeRetirement` decides when a session runtime may be released and owns the single wake-up timer; the release itself is the ordinary `SessionLifecycle` close, so the session, its persisted transcript, its history, and its sidebar row survive and the next prompt reloads the provider session.
- A session is released after `SESSION_RUNTIME_IDLE_RETIREMENT_MS` (30 minutes) measured from both its last reply and the moment the user last switched away from it, and only when it is fully settled: not on screen, no turn streaming, no unanswered plan or approval, nothing queued, compacting, interrupting, or steering, no child agent working, no embedded browser open, and no model choice still to reach the provider. The session the renderer reports as on screen is never released, and neither is a session hidden only because the window is minimized.
- Nothing is retirable until the renderer has reported which session is on screen, and the decision is taken again immediately before each close, so a prompt arriving while an earlier session is being released keeps the sessions behind it alive.
- Viewing a released session costs nothing: the transcript is served from persisted history in under 10 milliseconds regardless of its length, and only a prompt reloads the provider session, which measures about 0.7 seconds. The budget is six times the child budget despite that reload being the cheaper of the two, because of where the cost lands: a child pays behind its own loading state, a session pays after the user has typed a prompt and pressed enter.
- A sidecar restart applies the same rules before spending anything. `SessionAdoption` resurrects the sessions recorded in `live-runtime.json`, which spawns a provider process each, so it asks `sessionRuntimeRetirement` first and leaves any session already past the budget closed and reopenable rather than spawning a process for the first sweep to release. A restart takes every provider process, browser, and pending edit with it, so the journal records when each session was last active and adoption reads the exit phase and journalled child statuses alongside it. Sessions interrupted mid-turn, waiting on the user, or holding unsettled children are resurrected as before.

### History persistence

- `HistoryPersistence` is the sidecar-facing history seam. It keeps canonical live summary and child overlays immediately readable while persistence is pending.
- `HistoryPersistenceQueue` retains transcript metadata losslessly, collapses pending summaries and child records by stable identity, and enforces explicit row and byte ceilings.
- Ordinary writes flush on a short debounce or batch limit with SQLite WAL `synchronous=NORMAL`. Reconciliation drains pending transactions for read consistency without forcing a durability checkpoint. Session creation, turn settlement, provider replacement, compaction, child settlement, unregister, and shutdown additionally force a `synchronous=FULL` WAL checkpoint before the corresponding completed state is published.
- One writer worker thread owns the SQLite connection and executes each batch inside one `BEGIN IMMEDIATE` transaction. A transactional writer-generation lease rejects work from a timed-out worker after its replacement starts, so late termination cannot overwrite recovered state or cross a durability checkpoint. Failed transactions roll back completely, the queue retains the batch, and the supervised client recreates a failed worker with bounded exponential retry. Live output continues while bounded queue capacity remains; durability boundaries fail visibly until recovery.
- A separate index worker owns provider-file tree reconciliation, targeted watcher reconciliation, search-text extraction, and SQLite FTS5 updates. It returns revisioned cache deltas; a missed delta triggers an authoritative snapshot before the sidecar changes its in-memory historical summaries or provider-path index. The orchestration thread never walks the provider-file tree or rebuilds the derived cache; explicit history page loads still parse only the indexed provider paths needed for that page. The first session list and a post-close list publish only after their reconciliation result is applied.
- Full-text content indexing is incremental and restartable. Each transaction advances a persisted byte cursor and indexed-tail fingerprint, so appends index only new JSONL records and a restart resumes at the last committed boundary. File replacement, truncation, or a changed indexed tail rebuilds only that provider's derived rows; deletion removes rows through an indexed provider-to-row mapping.
- Upgrade backfill is deliberately resource-light. Chats updated during the last seven days are processed first in 256 KiB target slices, paced at one slice every two seconds while the desktop is active. After Electron reports at least 60 seconds of operating-system idle time, that recent lane also uses the five-second idle cadence so a quiet machine is not ground by search backfill. An individual JSONL record that exceeds the slice ceiling is skipped so malformed or unbounded lines cannot grow worker memory without limit. Older chats stay unarmed until that same idle sample and then advance one slice every five seconds. Live transcript, streaming-session, running-child, and interactive search work pause the idle lane; the next desktop activity sample resumes it only if the machine remains idle. Large archives may therefore take days to finish without delaying active agent work.
- Renderer search commands carry a `requestId` and query. Queries of at least three characters run against the persisted FTS5 trigram index, preserve case-insensitive substring/snippet behavior, resolve provider and compaction aliases to canonical app sessions, and discard superseded request results. Results remain useful while backfill is partial and grow as older slices commit.
- Canonical durability uses `session-index.sqlite`; rebuildable file-summary and FTS5 state uses the separate `session-search.sqlite`. The canonical schema version and user-data rows are unchanged. An absent, old, or corrupt derived database is rebuilt from provider JSONL without modifying canonical sessions, children, or event rows; deleting `session-search.sqlite` plus its WAL/SHM files is the explicit recovery step for derived-index corruption. The worker bundle ships beside `sidecar.mjs` in packaged updates.
- The worker bundle carries no third-party runtime: both worker isolates compile it, so a value import of the Droid SDK from the history graph costs the sidecar tens of MiB of resident memory for code the workers never call. `historyWorkerBundle.test.ts` gates this.

### Renderer child navigation

- The left navigation and `sessions.list` contain parent sessions only.
- The active parent's canonical child summaries appear in the right context panel, including historical and same-role siblings.
- Selection, readiness, transcript filtering, settings, send, steer, Stop, and interrupt all resolve through one visible target keyed by `parentAppSessionId + childSessionId`.
- A provider runtime identity is never stored as a renderer child key. Historical or unavailable children remain selectable for transcript review while mutating actions stay disabled.

### Renderer transcript runtime

- The renderer store exposes one canonical array-shaped transcript per `appSessionId`, backed by immutable 128-event chunks. Streaming replaces only the bounded live chunk; settled chunks remain shared across store revisions, history slices, feed projection, snapshots, and inactive-session caching. The adapter is read-compatible with existing array consumers but rejects mutation.
- Each transcript runtime owns a persistent bucketed event-ID index, first-user pointer, latest child activity by source, and merged child-spawn index. Duplicate checks and child-panel derivations therefore do not scan retained history. Ordered bridge batches still preserve every non-transcript action as an ordering barrier.
- Each transcript write publishes a revision record with its prior revision, prior length, and first changed index. Exact older-page insertion publishes prepend provenance; history replacement, retained-window release, and any uncertain batch lineage publish a reset. Duplicate events do not advance the revision, and session removal prunes the transcript and its revision together.
- `ChatView` derives the visible primary or child transcript and grouped feed through a bounded projector. A proven append rebuilds only the earliest affected user turn, expanding backward when tool-call/result correlation crosses the boundary. Settled visible/feed chunks retain reference identity, and `MessageFeed` memoizes those chunks so a live token reconciles current rows rather than recreating every historical row element. Reset, missed revision, source-length mismatch, selection change, pending-state change, or feed-option change uses the canonical full builder.
- Mission Control visibility, spec-path discovery, timeline anchors, final-response markers, entrance keys, and child-session panels consume the same mutation lineage or runtime indexes. Normal live-tail updates inspect only the changed suffix/current turn; older-history prepends may deliberately process the inserted page while retaining the existing suffix chunks and viewport row identities.
- Child or sibling output that is invisible to the selected conversation advances provenance without replacing the visible transcript or feed references. Agent execution, event ingestion, persistence, settlement, and child supervision always continue for inactive or obscured conversations; only derived renderer work is reused.
- The projector keeps at most two inactive feed projections and only when both the complete session transcript and selected transcript contain at most 1,600 events and the retained transcript payload remains below the store's high-water budget. Larger histories remain cacheable only while active and are released from the projector on navigation. Conversation scroll snapshots restore by stable feed-row tail identity, so history prepends and warm switches preserve the reader's anchor without changing row keys.

### Autonomy

- The canonical levels are `off`, `low`, `medium`, and `high`, shared verbatim by the renderer, the bridge protocol, and the sidecar.
- Every `session.create` carries an explicit autonomy snapshot. The sidecar fails fast when it is missing instead of falling back to provider or factory defaults.
- The application default (Medium on first run) is persisted by the renderer and edited only in Settings → Configuration. The composer drafts a per-session override from that default; the draft resets whenever the create target changes.
- Starting a Mission requires High autonomy. The composer blocks a lower draft behind an explicit choice to raise it; autonomy is never elevated silently.
- Live changes go provider-first through `session.updateSettings`, serialized per session. The renderer shows a pending state and settles only when the confirmed summary arrives; rejections surface as recoverable `session.autonomy_update_failed` errors, and a settlement that lands after close or provider replacement is discarded.
- Child sessions report their confirmed effective autonomy only while their runtime is live. It is read from the provider init result, never persisted, and never inherited from the parent; historical or unopened children report none and the renderer labels them provider managed.

## Performance instrumentation

Perf phase 0 (#116) instruments the full event path — provider event →
normalized → persisted → transport → renderer receive → store commit → next
paint — and provides a deterministic replay harness for validating every later
performance change.

### Sidecar hot-path metrics

- `sidecar/src/telemetry/hotPathMetrics.ts` records always-on stage
  histograms (`normalize`, SQLite `persist`, `emit` dispatch, `transport`
  fan-out, coalesced-delta batch sizes), transport byte rates, event-loop
  delay, process CPU/memory, and resource gauges (live sessions, child
  agents).
- `sidecar/src/bridgeServer.ts` owns the authenticated WebSocket fan-out and
  the token-gated HTTP routes. `GET /perf/metrics?token=<BRIDGE_TOKEN>`
  returns the current snapshot as JSON for live diagnosis and for the harness.
- The sidecar entry (`sidecar/src/index.ts`) enables the collector at
  readiness and samples `SessionManager.resourceCounts()` for the gauges.

### Ordered bridge transport

The sidecar assigns process-generation sequence numbers at the single outbound
bridge boundary and groups ordinary events into short bounded batches. Only
replaceable session/context telemetry can collapse, and never across a
non-replaceable event. Approvals, questions, errors, lifecycle boundaries,
history responses, and turn settlement flush immediately.

Renderers must advertise bridge protocol 3, apply one wire batch as one
ordered store transition, and reconnect with the last fully applied generation
and sequence. Same-generation reconnects replay the retained buffer. A new
process generation or a replay gap delivers a compact `bridge.snapshot` of
live sessions and runtime state instead of a hard resync; `bridge.reset` is
reserved for an invalid resume cursor. Electron owns sidecar health
(`starting`, `healthy`, `degraded`, `restarting`, `recovery-required`,
`stopped`) and bounded restart; `GET /health` is a cheap liveness probe, not a
death signal while the process is still alive. A missed or slow `/health`
while the child is still running is `degraded`; only a real process `exit`
restarts. The probe does not sample event-loop delay. Production leaves the
10 ms histogram off; support can arm it for the rest of that sidecar process
with `GET /perf/metrics?token=…&eventLoop=1`. Clients using another protocol
version are rejected instead of entering a compatibility path. The sidecar
retains a bounded same-process replay window and terminates clients whose
socket buffers cross the hard ceiling.

### Renderer metrics

- `src/lib/rendererPerf.ts` measures bridge receive → store commit → next
  paint per event batch, the age of `event.appended` messages at socket read,
  long tasks (`PerformanceObserver`), the mounted grouped feed-row count
  (reported by the feed), and full, incremental, cached,
  or invisible feed projection work with rebuilt/reused event totals.
- The snapshot is available in the console via
  `window.__droidexPerf.getSnapshot()`.

### Conversation find and range copy

Virtualized conversation rows are not a searchable or selectable document.
In-conversation find (Cmd/Ctrl+F) and range copy read retained feed state, then
scroll with `ConversationListHandle.scrollToRow`. Match counts say "in loaded
history" when older pages remain on disk, and find offers to load them instead
of reporting a silent miss. Find does not raise overscan or remount the
transcript.

### Electron main gauges

- `electron/performanceMetrics.cjs` collects live WebContents, live PTYs, and
  process memory/CPU; the renderer reads it through
  `window.droidControl.getPerformanceMetrics()`.

### Replay harness

`npm run perf:replay -- --scenario <name>` boots the real sidecar pipeline
(SessionManager, SessionEventFlow, SessionTimeline, SQLite history, bridge
WebSocket) against a scripted provider and writes JSON + Markdown artifacts
to `reports/perf/`. Headless scenarios: `smoke`, `idle`, `streaming`,
`multi-agent`, `agents-4`, `agents-16`, `agents-27`, `long-history`,
`long-tail`, `session-switch`, `soak`. Browser/design workspace, hidden-window
CPU, and sidecar-restart are documented skips (restart belongs to the
supervision phase).

A/B probes (`npm run perf:compare` / `npm run perf:report`) measure the same
self-contained metrics on a baseline git worktree and on this tree. Metrics
that need phase-0/1/4 code are labelled **candidate-only** and never get a
fabricated baseline. `npm run perf:gates` / `npm run quality:perf-gates` fail
on bounded mounted rows, bounded queues, marker loss, soak leaks, terminal
delivery amplification, and feed rebuild counts. Timing CPU/RSS is recorded
and warned, not failed, on shared runners. Bundle bytes stay gated by
`npm run quality:bundle-budgets`. Release numbers live in
`docs/performance-budgets.md`.

## Build path

`npm run build` runs frontend typecheck and Vite build, builds the sidecar bundles, and syntax-checks Electron CommonJS entrypoints. The sidecar build emits `sidecar/dist/sidecar.mjs` plus `sidecar/dist/historyPersistenceWorker.mjs`; Electron uses the former unless `SIDECAR_ENTRY` is set and packages both from `sidecar/dist`.

## Update path

Free, ad-hoc-signed macOS builds use Sparkle against architecture-specific,
EdDSA-signed appcasts and ZIPs in the public
`droidex-anas/droidex-releases` repository. DROIDEX may check for a new
version in the background, but download and installation always require an
explicit user action. The future Developer ID path uses `electron-updater` and
`latest-mac.yml`. The source repository is never a client update feed.

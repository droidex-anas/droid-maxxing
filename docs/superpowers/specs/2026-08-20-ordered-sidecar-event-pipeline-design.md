# Ordered sidecar event pipeline

Issue: #117  
Parent: #115

## Decision

DROIDEX will keep the existing provider/session semantics and place one ordered,
bounded transport pipeline at the sidecar's outbound bridge boundary.

The pipeline assigns every broadcast domain event a process-generation sequence,
forms short frame-sized batches, collapses only replaceable telemetry, and sends
one renderer message per batch. The renderer applies one server batch through
one ordered reducer batch while preserving existing per-event subscriptions.

This change does not alter React components, styling, motion, transitions, chat
layout, or animation timing. It reduces the number of cross-process messages and
state commits that feed the existing UI.

## Why this boundary

`bridgeServer.ts` is the only production outbound transport and is also used by
the deterministic replay harness. Keeping batching there provides one owner for:

- sequence assignment;
- batch timing and limits;
- safe telemetry replacement;
- WebSocket serialization/fan-out;
- slow-client backpressure;
- bounded reconnect replay; and
- transport metrics.

Session modules continue to emit ordinary `ServerEvent` values. They do not know
about sockets, batches, replay cursors, or renderer frame cadence.

## Invariants

1. **Logical order is never guessed.** Broadcast domain events receive sequence
   numbers before any replacement or batching.
2. **Non-replaceable events are lossless.** Transcript events, user decisions,
   questions, errors, lifecycle boundaries, tool results, and history payloads
   are never discarded.
3. **Replacement cannot cross a semantic barrier.** A replaceable telemetry
   snapshot may replace an older snapshot for the same key only while no
   non-replaceable event occurred between them.
4. **Priority events do not wait behind a timer.** Pending ordinary events flush
   before the priority event is sent in its own immediate batch.
5. **Queues are bounded.** Event count, estimated pending bytes, replay bytes,
   replay batches, and client socket buffers all have explicit ceilings.
6. **A reconnect cannot silently skip a known gap.** It receives retained
   batches or an explicit reset reason.
7. **Unsupported protocol versions are rejected.** Clients that do not advertise
   the current bridge protocol are closed with code 1002. There is no unpacked
   one-event compatibility path.
8. **The renderer speaks one wire format.** Dual-format acceptance was dropped
   with the compatibility path; a client must advertise the current protocol.

## Wire protocol

A batch-capable renderer adds `bridgeProtocol=2` to the authenticated WebSocket
URL. The sidecar replies with:

```ts
interface ServerEventBatch {
  type: 'events.batch';
  generation: string;
  firstSeq: number;
  lastSeq: number;
  events: Array<{
    seq: number;
    event: ServerEvent;
  }>;
}
```

`firstSeq` and `lastSeq` cover every logical input event represented by the
batch. Delivered entries can contain sequence gaps when intermediate telemetry
snapshots were safely replaced. Each delivered entry carries the sequence of
its latest represented value.

The process generation is a random UUID created with the batcher. Sequence
numbers are monotonic within that generation. Client-local control responses
such as malformed-command errors and `bridge.reset` are intentionally outside
the broadcast sequence: they are addressed to one socket and cannot create a
global sequence gap for other authenticated clients.

## Batch policy

The normal window starts at 16 ms. Under socket pressure it expands to 32 ms so
replaceable telemetry has more opportunity to collapse. A batch flushes early
when either of these defaults is reached:

- 512 logical events; or
- 512 KiB of estimated delivered payload.

These are correctness and memory bounds, not performance targets. Phase 0 replay
results should be used to retune them.

### Replaceable telemetry

The initial policy is intentionally narrow:

- latest `session.updated` per `appSessionId`; and
- latest `context.updated` per exact app/source/child identity.

Transcript delta merging remains owned by `SessionTimeline`, where its
persistence and renderer-mirror semantics already live. The transport does not
introduce a third transcript merge implementation.

### Immediate boundaries

The implementation flushes before latency- or correctness-sensitive events,
including connection/runtime boundaries, session creation/close, turn
settlement, approvals, questions, errors, history responses, native browser
requests, and request-correlated completion responses.

## Backpressure

The sidecar monitors each socket's `bufferedAmount`.

- At the soft threshold (512 KiB by default), future ordinary batches use the
  longer window.
- At the hard threshold (8 MiB by default), the client is terminated rather
  than allowing unbounded memory growth.

A batch-capable renderer reconnects with its generation and last fully applied
sequence. A legacy mixed-version renderer cannot replay because its protocol has
no cursor; the compatibility path exists for update safety, not as the final
slow-client recovery mechanism.

## Replay

Before evaluating a resume cursor, the sidecar flushes the current timer
window. A reset can therefore never acknowledge a sequence that is still
pending and would later be discarded by the renderer as already applied.

The sidecar retains a bounded same-process replay window:

- up to 4,096 batches; and
- up to 32 MiB of serialized batch data.

The buffer uses a head index rather than shifting the array on every eviction,
and clears each evicted slot immediately so serialized payloads become garbage
collectable before periodic array compaction. It remembers the latest sequence
even if an oversized batch is evicted, so a
reconnect receives `replay_unavailable` instead of silently missing data.

Reconnect outcomes:

- same generation + retained cursor: replay missing batches;
- different generation: `generation_changed` reset;
- cursor older than retained history: `replay_unavailable` reset; or
- malformed/future cursor: `invalid_resume` reset.

Full authoritative snapshot recovery after a sidecar process restart remains
owned by #125. Phase 1 makes gaps explicit and same-process reconnects safe.

## Renderer ingestion

`Bridge` exposes both APIs:

- `subscribe(listener)` retains existing per-event behavior for command waiters
  and other narrow consumers;
- `subscribeBatch(listener)` receives all logical events from one wire batch in
  one callback.

The root store uses `subscribeBatch`, adapts each event in order, discards perf
samples for events that produce no reducer action, and sends the resulting
actions through one `BATCH` reducer transition. The existing local-action rule
still flushes already-received bridge work first.

The UI receives the same final state and keeps all existing animations. The
only intentionally removed states are redundant telemetry snapshots that could
not have produced a distinct painted frame.

## Shutdown

Manager shutdown runs while the transport is still available so final emitted
state can be flushed. The bridge then flushes its batcher, requests a graceful
socket close, and force-terminates stalled clients after a bounded 250 ms drain.

## Metrics

Phase 1 extends the Phase 0 snapshot with:

- logical versus delivered events;
- event reduction ratio;
- batch count and immediate-batch count;
- batch event/byte distributions;
- queue delay;
- queue current/peak count, bytes, and age;
- socket buffered-byte high-water mark;
- replay buffer current/peak bytes and batches;
- replayed batches/events/bytes; and
- hard-pressure disconnects.

## Non-goals

- No UI redesign or animation reduction.
- No SQLite write-behind implementation; that is #118.
- No transcript runtime rewrite; that is #119.
- No MessagePort/utility-process migration; that is #122.
- No cross-process authoritative snapshot recovery; that is #125.

## Validation

The implementation must cover:

- 27 interleaved sources in one ordered frame batch;
- telemetry replacement and barrier behavior;
- priority flush ordering;
- queue count/byte bounds;
- pressure-adjusted windows;
- replay success, eviction gaps, oversized batches, and invalid ordering;
- legacy renderer fallback;
- batch-capable renderer delivery;
- reconnect cursor propagation and duplicate replay suppression;
- stale replaced-socket suppression and sequence-gap reconnect behavior;
- explicit reset cursor/diagnostic behavior;
- one reducer commit per server batch; and
- Phase 0 replay harness compatibility with both direct and batch wire messages.

# Perf comparison

- Date: 2026-08-27T13:17:54.604Z
- Baseline: `origin/main` @ `99f5ca882147a1641298072e5b64deeaa3d52062`
- Candidate: `cbde0a990c43b6cb1bcca3b671966658046561ab`
- Node v22.14.0 on linux/x64

A/B-measurable metrics ran on both refs using this branch’s probes against each tree’s own production APIs. Candidate-only metrics have no baseline; they are absolute numbers against budgets, not improvements.

## A/B-measurable

| Metric | Baseline | Candidate | Delta | Δ% | Method |
| --- | --- | --- | --- | --- | --- |
| `bundle.initialCssBytes` | 91089 | 85745 | -5344 | -5.9% | dist/index.html entry css |
| `bundle.initialJsBytes` | 1554577 | 1203751 | -350826 | -22.6% | dist/index.html entry script |
| `bundle.totalJsBytes` | 6965105 | 7050164 | 85059 | +1.2% | sum of dist/assets/*.js |
| `feed.eventsRebuiltPerDelta` | 202 | 2 | -200 | -99.0% | feed items from rebuiltFromFeedItemIndex to end after an incremental tail append |
| `feed.mountedRowsAt10k` | 10000 | 17 | -9983 | -99.8% | tanstack Virtualizer with this tree’s conversationListState constants |
| `feed.projectionMsPerDelta` | 0.214 | 0.014 | -0.2 | -93.5% | createChatFeedProjector incremental tail appends |
| `feed.rowVisitsPerTailDeltaAt10k` | 10000 | 17 | -9983 | -99.8% | rows participating in a tail update equal the mounted window on this tree |
| `markdown.perDeltaRenderMs` | 1.001 | 0.634 | -0.366 | -36.6% | renderToStaticMarkup of this tree’s Markdown on a growing stream |
| `terminal.deliveriesPerFlood` | 1000 | 2 | -998 | -99.8% | MessagePort data posts after a 1000-chunk flood |

## Candidate-only (not an improvement claim)

| Metric | Candidate | Unit | Method |
| --- | --- | --- | --- |
| `replay.smoke.eventReductionRatio` | 0.026 | ratio | sidecar transport logical→delivered reduction |
| `replay.smoke.pendingEventsMax` | 4 | events | transport queue high-water during this replay |
| `replay.smoke.pendingEstimatedBytesMax` | 1747 | bytes | transport queued bytes high-water during this replay |
| `replay.smoke.persistenceBoundaryP95Ms` | 15.864 | ms | write-behind durability boundary p95 |
| `replay.smoke.rssBytes` | 223813632 | bytes | process RSS after this replay; warn-only |
| `replay.idle.eventReductionRatio` | 0.087 | ratio | sidecar transport logical→delivered reduction |
| `replay.idle.pendingEventsMax` | 5 | events | transport queue high-water during this replay |
| `replay.idle.pendingEstimatedBytesMax` | 2071 | bytes | transport queued bytes high-water during this replay |
| `replay.idle.persistenceBoundaryP95Ms` | 10.588 | ms | write-behind durability boundary p95 |
| `replay.idle.rssBytes` | 219148288 | bytes | process RSS after this replay; warn-only |
| `replay.streaming.eventReductionRatio` | 0.006 | ratio | sidecar transport logical→delivered reduction |
| `replay.streaming.pendingEventsMax` | 5 | events | transport queue high-water during this replay |
| `replay.streaming.pendingEstimatedBytesMax` | 2282 | bytes | transport queued bytes high-water during this replay |
| `replay.streaming.persistenceBoundaryP95Ms` | 15.6 | ms | write-behind durability boundary p95 |
| `replay.streaming.rssBytes` | 200024064 | bytes | process RSS after this replay; warn-only |
| `replay.agents-4.eventReductionRatio` | 0.005 | ratio | sidecar transport logical→delivered reduction |
| `replay.agents-4.pendingEventsMax` | 9 | events | transport queue high-water during this replay |
| `replay.agents-4.pendingEstimatedBytesMax` | 4557 | bytes | transport queued bytes high-water during this replay |
| `replay.agents-4.persistenceBoundaryP95Ms` | 19.377 | ms | write-behind durability boundary p95 |
| `replay.agents-4.rssBytes` | 226521088 | bytes | process RSS after this replay; warn-only |
| `replay.agents-16.eventReductionRatio` | 0.013 | ratio | sidecar transport logical→delivered reduction |
| `replay.agents-16.pendingEventsMax` | 36 | events | transport queue high-water during this replay |
| `replay.agents-16.pendingEstimatedBytesMax` | 17622 | bytes | transport queued bytes high-water during this replay |
| `replay.agents-16.persistenceBoundaryP95Ms` | 14.139 | ms | write-behind durability boundary p95 |
| `replay.agents-16.rssBytes` | 226770944 | bytes | process RSS after this replay; warn-only |
| `replay.agents-27.eventReductionRatio` | 0.019 | ratio | sidecar transport logical→delivered reduction |
| `replay.agents-27.pendingEventsMax` | 57 | events | transport queue high-water during this replay |
| `replay.agents-27.pendingEstimatedBytesMax` | 28646 | bytes | transport queued bytes high-water during this replay |
| `replay.agents-27.persistenceBoundaryP95Ms` | 10.542 | ms | write-behind durability boundary p95 |
| `replay.agents-27.rssBytes` | 242368512 | bytes | process RSS after this replay; warn-only |
| `replay.multi-agent.eventReductionRatio` | 0.002 | ratio | sidecar transport logical→delivered reduction |
| `replay.multi-agent.pendingEventsMax` | 17 | events | transport queue high-water during this replay |
| `replay.multi-agent.pendingEstimatedBytesMax` | 8579 | bytes | transport queued bytes high-water during this replay |
| `replay.multi-agent.persistenceBoundaryP95Ms` | 14.339 | ms | write-behind durability boundary p95 |
| `replay.multi-agent.rssBytes` | 217604096 | bytes | process RSS after this replay; warn-only |
| `replay.long-tail.eventReductionRatio` | 0.002 | ratio | sidecar transport logical→delivered reduction |
| `replay.long-tail.pendingEventsMax` | 7 | events | transport queue high-water during this replay |
| `replay.long-tail.pendingEstimatedBytesMax` | 3658 | bytes | transport queued bytes high-water during this replay |
| `replay.long-tail.persistenceBoundaryP95Ms` | 25.747 | ms | write-behind durability boundary p95 |
| `replay.long-tail.rssBytes` | 257851392 | bytes | process RSS after this replay; warn-only |
| `replay.session-switch.eventReductionRatio` | 0.009 | ratio | sidecar transport logical→delivered reduction |
| `replay.session-switch.pendingEventsMax` | 9 | events | transport queue high-water during this replay |
| `replay.session-switch.pendingEstimatedBytesMax` | 4332 | bytes | transport queued bytes high-water during this replay |
| `replay.session-switch.persistenceBoundaryP95Ms` | 16.083 | ms | write-behind durability boundary p95 |
| `replay.session-switch.rssBytes` | 255229952 | bytes | process RSS after this replay; warn-only |
| `replay.soak.eventReductionRatio` | 0 | ratio | sidecar transport logical→delivered reduction |
| `replay.soak.pendingEventsMax` | 0 | events | transport queue high-water during this replay |
| `replay.soak.pendingEstimatedBytesMax` | 0 | bytes | transport queued bytes high-water during this replay |
| `replay.soak.persistenceBoundaryP95Ms` | 15.648 | ms | write-behind durability boundary p95 |
| `replay.soak.rssBytes` | 331530240 | bytes | process RSS after this replay; warn-only |

## Deterministic gates

| Gate | Actual | Budget | Mode | Status |
| --- | --- | --- | --- | --- |
| mounted conversation rows for 10k history | 17 | 80 | hard | pass |
| row visits per streamed tail token at 10k | 17 | 80 | hard | pass |
| visible events rebuilt per tail delta | 2 | 8 | hard | pass |
| renderer deliveries for 1000 PTY chunks | 2 | 16 | hard | pass |
| live primary sessions after soak cleanup | 0 | 0 | hard | pass |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 4 | 4096 | hard | pass |
| transport pending bytes high-water | 1747 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 223813632 | n/a | warn | warn |
| process CPU user time | 203.468 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 5 | 4096 | hard | pass |
| transport pending bytes high-water | 2071 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 219148288 | n/a | warn | warn |
| process CPU user time | 24.633 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 5 | 4096 | hard | pass |
| transport pending bytes high-water | 2282 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 200024064 | n/a | warn | warn |
| process CPU user time | 546.425 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 9 | 4096 | hard | pass |
| transport pending bytes high-water | 4557 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 4 | 4 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 226521088 | n/a | warn | warn |
| process CPU user time | 198.624 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 36 | 4096 | hard | pass |
| transport pending bytes high-water | 17622 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 16 | 16 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 226770944 | n/a | warn | warn |
| process CPU user time | 226.353 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 57 | 4096 | hard | pass |
| transport pending bytes high-water | 28646 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 27 | 27 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 242368512 | n/a | warn | warn |
| process CPU user time | 206.787 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 17 | 4096 | hard | pass |
| transport pending bytes high-water | 8579 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 8 | 8 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 217604096 | n/a | warn | warn |
| process CPU user time | 917.316 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 7 | 4096 | hard | pass |
| transport pending bytes high-water | 3658 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 257851392 | n/a | warn | warn |
| process CPU user time | 289.364 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 9 | 4096 | hard | pass |
| transport pending bytes high-water | 4332 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 4 | 4 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 255229952 | n/a | warn | warn |
| process CPU user time | 104.114 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 0 | 4096 | hard | pass |
| transport pending bytes high-water | 0 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 0 | 0 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 331530240 | n/a | warn | warn |
| process CPU user time | 496.608 | n/a | warn | warn |

All measured hard gates passed.

## Scenarios not run here

- `history-10k`: Renderer probe, not a sidecar replay: synthetic 10k-row mounted-window measurement.
- `terminal-flood`: Electron probe, not a sidecar replay: PTY flood through the tree’s own output delivery.
- `browser-workspace`: Needs a GUI browser/design workspace; not headless-feasible.
- `hidden-window`: Needs a real Electron window and visibility signals; not headless-feasible.
- `sidecar-restart`: Owned by the concurrent supervision phase; this suite records the gap and does not build it.

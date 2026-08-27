# Perf comparison

- Date: 2026-08-27T15:16:29.254Z
- Baseline: `origin/main` @ `99f5ca882147a1641298072e5b64deeaa3d52062`
- Candidate: `2c7671a1016a7a43a7fd964f129d5477a8eb5ca8`
- Node v22.14.0 on linux/x64

A/B-measurable metrics ran on both refs using this branch’s probes against each tree’s own production APIs. Candidate-only metrics have no baseline; they are absolute numbers against budgets, not improvements.

## A/B-measurable

| Metric | Baseline | Candidate | Delta | Δ% | Method |
| --- | --- | --- | --- | --- | --- |
| `bundle.initialCssBytes` | 91089 | 85700 | -5389 | -5.9% | dist/index.html entry css |
| `bundle.initialJsBytes` | 1554577 | 1220376 | -334201 | -21.5% | dist/index.html entry script |
| `bundle.totalJsBytes` | 6965105 | 7065891 | 100786 | +1.4% | sum of dist/assets/*.js |
| `feed.eventsRebuiltPerDelta` | 202 | 2 | -200 | -99.0% | feed items from rebuiltFromFeedItemIndex to end after an incremental tail append |
| `feed.mountedRowsAt10k` | 10000 | 17 | -9983 | -99.8% | tanstack Virtualizer with this tree’s conversationListState constants |
| `feed.projectionMsPerDelta` | 0.18 | 0.014 | -0.166 | -92.3% | createChatFeedProjector incremental tail appends |
| `feed.rowVisitsPerTailDeltaAt10k` | 10000 | 17 | -9983 | -99.8% | rows participating in a tail update equal the mounted window on this tree |
| `markdown.perDeltaRenderMs` | 0.927 | 0.601 | -0.326 | -35.1% | renderToStaticMarkup of this tree’s Markdown on a growing stream |
| `sidecar.firstSessionsListMs` | 123.674 | 258.219 | 134.544 | +108.8% | median of 5 spawn→first sessions.list timings via ordered bridge batches |
| `sidecar.readyMs` | 117.964 | 121.495 | 3.531 | +3.0% | median of 5 spawn→SIDECAR_READY timings on sidecar/dist/sidecar.mjs |
| `terminal.deliveriesPerFlood` | 1000 | 2 | -998 | -99.8% | MessagePort data posts after a 1000-chunk flood |

## Candidate-only (not an improvement claim)

| Metric | Candidate | Unit | Method |
| --- | --- | --- | --- |
| `replay.smoke.eventReductionRatio` | 0.026 | ratio | sidecar transport logical→delivered reduction |
| `replay.smoke.pendingEventsMax` | 4 | events | transport queue high-water during this replay |
| `replay.smoke.pendingEstimatedBytesMax` | 1747 | bytes | transport queued bytes high-water during this replay |
| `replay.smoke.persistenceBoundaryP95Ms` | 15.591 | ms | write-behind durability boundary p95 |
| `replay.smoke.rssBytes` | 272052224 | bytes | process RSS after this replay; warn-only |
| `replay.idle.eventReductionRatio` | 0.087 | ratio | sidecar transport logical→delivered reduction |
| `replay.idle.pendingEventsMax` | 5 | events | transport queue high-water during this replay |
| `replay.idle.pendingEstimatedBytesMax` | 2071 | bytes | transport queued bytes high-water during this replay |
| `replay.idle.persistenceBoundaryP95Ms` | 10.513 | ms | write-behind durability boundary p95 |
| `replay.idle.rssBytes` | 252940288 | bytes | process RSS after this replay; warn-only |
| `replay.streaming.eventReductionRatio` | 0.006 | ratio | sidecar transport logical→delivered reduction |
| `replay.streaming.pendingEventsMax` | 5 | events | transport queue high-water during this replay |
| `replay.streaming.pendingEstimatedBytesMax` | 2282 | bytes | transport queued bytes high-water during this replay |
| `replay.streaming.persistenceBoundaryP95Ms` | 15.729 | ms | write-behind durability boundary p95 |
| `replay.streaming.rssBytes` | 200609792 | bytes | process RSS after this replay; warn-only |
| `replay.agents-4.eventReductionRatio` | 0.005 | ratio | sidecar transport logical→delivered reduction |
| `replay.agents-4.pendingEventsMax` | 11 | events | transport queue high-water during this replay |
| `replay.agents-4.pendingEstimatedBytesMax` | 5134 | bytes | transport queued bytes high-water during this replay |
| `replay.agents-4.persistenceBoundaryP95Ms` | 15.539 | ms | write-behind durability boundary p95 |
| `replay.agents-4.rssBytes` | 229634048 | bytes | process RSS after this replay; warn-only |
| `replay.agents-16.eventReductionRatio` | 0.013 | ratio | sidecar transport logical→delivered reduction |
| `replay.agents-16.pendingEventsMax` | 35 | events | transport queue high-water during this replay |
| `replay.agents-16.pendingEstimatedBytesMax` | 17293 | bytes | transport queued bytes high-water during this replay |
| `replay.agents-16.persistenceBoundaryP95Ms` | 10.538 | ms | write-behind durability boundary p95 |
| `replay.agents-16.rssBytes` | 236191744 | bytes | process RSS after this replay; warn-only |
| `replay.agents-27.eventReductionRatio` | 0.019 | ratio | sidecar transport logical→delivered reduction |
| `replay.agents-27.pendingEventsMax` | 59 | events | transport queue high-water during this replay |
| `replay.agents-27.pendingEstimatedBytesMax` | 29147 | bytes | transport queued bytes high-water during this replay |
| `replay.agents-27.persistenceBoundaryP95Ms` | 10.474 | ms | write-behind durability boundary p95 |
| `replay.agents-27.rssBytes` | 251461632 | bytes | process RSS after this replay; warn-only |
| `replay.multi-agent.eventReductionRatio` | 0.002 | ratio | sidecar transport logical→delivered reduction |
| `replay.multi-agent.pendingEventsMax` | 17 | events | transport queue high-water during this replay |
| `replay.multi-agent.pendingEstimatedBytesMax` | 8579 | bytes | transport queued bytes high-water during this replay |
| `replay.multi-agent.persistenceBoundaryP95Ms` | 10.502 | ms | write-behind durability boundary p95 |
| `replay.multi-agent.rssBytes` | 222363648 | bytes | process RSS after this replay; warn-only |
| `replay.long-tail.eventReductionRatio` | 0.002 | ratio | sidecar transport logical→delivered reduction |
| `replay.long-tail.pendingEventsMax` | 7 | events | transport queue high-water during this replay |
| `replay.long-tail.pendingEstimatedBytesMax` | 3658 | bytes | transport queued bytes high-water during this replay |
| `replay.long-tail.persistenceBoundaryP95Ms` | 21.05 | ms | write-behind durability boundary p95 |
| `replay.long-tail.rssBytes` | 251965440 | bytes | process RSS after this replay; warn-only |
| `replay.session-switch.eventReductionRatio` | 0.009 | ratio | sidecar transport logical→delivered reduction |
| `replay.session-switch.pendingEventsMax` | 8 | events | transport queue high-water during this replay |
| `replay.session-switch.pendingEstimatedBytesMax` | 4030 | bytes | transport queued bytes high-water during this replay |
| `replay.session-switch.persistenceBoundaryP95Ms` | 10.437 | ms | write-behind durability boundary p95 |
| `replay.session-switch.rssBytes` | 256712704 | bytes | process RSS after this replay; warn-only |
| `replay.soak.eventReductionRatio` | 0 | ratio | sidecar transport logical→delivered reduction |
| `replay.soak.pendingEventsMax` | 0 | events | transport queue high-water during this replay |
| `replay.soak.pendingEstimatedBytesMax` | 0 | bytes | transport queued bytes high-water during this replay |
| `replay.soak.persistenceBoundaryP95Ms` | 10.446 | ms | write-behind durability boundary p95 |
| `replay.soak.rssBytes` | 360833024 | bytes | process RSS after this replay; warn-only |

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
| process RSS | 272052224 | n/a | warn | warn |
| process CPU user time | 94.331 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 5 | 4096 | hard | pass |
| transport pending bytes high-water | 2071 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 252940288 | n/a | warn | warn |
| process CPU user time | 32.689 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 5 | 4096 | hard | pass |
| transport pending bytes high-water | 2282 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 200609792 | n/a | warn | warn |
| process CPU user time | 611.465 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 11 | 4096 | hard | pass |
| transport pending bytes high-water | 5134 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 4 | 4 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 229634048 | n/a | warn | warn |
| process CPU user time | 220.111 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 35 | 4096 | hard | pass |
| transport pending bytes high-water | 17293 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 16 | 16 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 236191744 | n/a | warn | warn |
| process CPU user time | 194.528 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 59 | 4096 | hard | pass |
| transport pending bytes high-water | 29147 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 27 | 27 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 251461632 | n/a | warn | warn |
| process CPU user time | 261.037 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 17 | 4096 | hard | pass |
| transport pending bytes high-water | 8579 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 8 | 8 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 222363648 | n/a | warn | warn |
| process CPU user time | 781.643 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 7 | 4096 | hard | pass |
| transport pending bytes high-water | 3658 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 1 | 1 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 251965440 | n/a | warn | warn |
| process CPU user time | 366.171 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 8 | 4096 | hard | pass |
| transport pending bytes high-water | 4030 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 4 | 4 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 256712704 | n/a | warn | warn |
| process CPU user time | 97.731 | n/a | warn | warn |
| tool-marker event loss | 0 | 0 | hard | pass |
| bridge sequence/order errors | 0 | 0 | hard | pass |
| transport pending events high-water | 0 | 4096 | hard | pass |
| transport pending bytes high-water | 0 | 33554432 | hard | pass |
| slow-client disconnects | 0 | 0 | hard | pass |
| live primary sessions after replay | 0 | 0 | hard | pass |
| history persistence overflow/degraded transitions | 0 | 0 | hard | pass |
| process RSS | 360833024 | n/a | warn | warn |
| process CPU user time | 540.51 | n/a | warn | warn |

All measured hard gates passed.

## Scenarios not run here

- `history-10k`: Renderer probe, not a sidecar replay: synthetic 10k-row mounted-window measurement.
- `terminal-flood`: Electron probe, not a sidecar replay: PTY flood through the tree’s own output delivery.
- `browser-workspace`: Needs a GUI browser/design workspace; not headless-feasible.
- `hidden-window`: Needs a real Electron window and visibility signals; not headless-feasible.
- `sidecar-restart`: Owned by the concurrent supervision phase; this suite records the gap and does not build it.

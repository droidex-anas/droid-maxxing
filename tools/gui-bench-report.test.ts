import assert from 'node:assert/strict';
import test from 'node:test';

import { delta, fmt, median, renderReport, spread, type RunResult } from './gui-bench-report.ts';

test('median and spread match odd/even samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual(spread([10, 2, 6]), { median: 6, min: 2, max: 10 });
});

test('report names the blank-hole method and software-raster caveat', () => {
  const stub: RunResult = {
    tree: 'baseline',
    run: 1,
    sha: 'base',
    coldOpen10kMs: 100,
    switchTo3kMs: 80,
    switchTo10kWarmMs: 90,
    idleCpuPercent: 10,
    idleRssBytes: 1000,
    appMetricsIdle: null,
    scroll3k: [],
    scroll10k: [
      {
        speed: 'flick',
        frameCount: 50,
        expectedFrames: 50,
        droppedFrames: 1,
        longestFrameMs: 33,
        longTasksOver50Ms: 0,
        longTaskMaxMs: 0,
        blankHitRatio: 0,
        blankDurationMs: 0,
        blankMaxRatio: 0.2,
        blankMaxHolePx: 16,
        mountedRowsMax: 380,
        mountedRowsLast: 380,
        cpuPercent: 40,
        rssBytes: 1_000_000,
      },
    ],
    children: { openMs: 20, mountedRows: 3, childRowCount: 5, scroll: null },
    streaming: {
      wired: false,
      reason: 'origin/main has no sidecar/src/perf/replayRuntime.ts',
      durationMs: 0,
      droppedFrames: 0,
      longestFrameMs: 0,
      longTasksOver50Ms: 0,
      cpuPercent: 0,
      rssBytes: 0,
    },
  };
  const candidate: RunResult = {
    ...stub,
    tree: 'candidate',
    sha: 'cand',
    scroll10k: [
      {
        ...stub.scroll10k[0]!,
        mountedRowsLast: 17,
        mountedRowsMax: 22,
        droppedFrames: 3,
      },
    ],
    streaming: { ...stub.streaming!, wired: true, reason: undefined, receiveToPaintCount: 40 },
  };
  const text = renderReport([stub, candidate], [
    { name: 'baseline', root: '/tmp/base', sha: 'base' },
    { name: 'candidate', root: '/tmp/cand', sha: 'cand' },
  ]);
  assert.match(text, /software-rasterizes/);
  assert.match(text, /hole taller than 96 px/);
  assert.match(text, /Blank during scroll/);
  assert.match(text, /unwired/);
  assert.equal(fmt({ median: 1.5, min: 1, max: 2 }), '1.5 [1.0–2.0]');
  assert.equal(delta(2, 5), '+3.0');
});

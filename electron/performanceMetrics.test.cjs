const test = require('node:test');
const assert = require('node:assert');

const { createPerformanceMetricsCollector } = require('./performanceMetrics.cjs');

test('collector reports injected PTY and WebContents counts with process health', () => {
  const { collect } = createPerformanceMetricsCollector({
    countPtys: () => 3,
    listWebContents: () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    nativeBrowserCounts: () => ({
      total: 3,
      live: 2,
      attached: 1,
      warm: 1,
      serialized: 1,
      maxLive: 2,
      idleMs: 0,
    }),
    terminalCounts: () => ({ live: 3, retained: 1, total: 4 }),
    powerTier: () => 'hidden',
  });

  const metrics = collect();
  assert.equal(metrics.ptys, 3);
  assert.equal(metrics.webContentsTotal, 4);
  assert.equal(metrics.nativeBrowsers.live, 2);
  assert.equal(metrics.nativeBrowsers.serialized, 1);
  assert.equal(metrics.terminals.retained, 1);
  assert.equal(metrics.powerTier, 'hidden');
  assert.ok(Number.isFinite(metrics.timestamp));
  assert.ok(metrics.memory.rssBytes > 0);
  assert.ok(metrics.memory.heapUsedBytes > 0);
  assert.ok(metrics.cpu.userMs >= 0);
  assert.ok(metrics.cpu.systemMs >= 0);
});

test('collector accumulates CPU against its construction baseline', async () => {
  const { collect } = createPerformanceMetricsCollector({ countPtys: () => 0 });
  const before = collect().cpu.userMs;
  let after = before;
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    // Burn user CPU so the delta is visible above timer noise.
    for (let index = 0; index < 1e6; index += 1) void index * 2;
    after = collect().cpu.userMs;
    if (after > before) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  // Strict growth, not >=: a regression that re-baselines on every collect()
  // would keep the delta at zero and must fail this test.
  assert.ok(
    after > before,
    `cpu user time did not advance beyond the baseline (${after} vs ${before})`,
  );
});

test('collector tolerates missing accessors', () => {
  const { collect } = createPerformanceMetricsCollector();
  const metrics = collect();
  assert.equal(metrics.ptys, 0);
  assert.equal(metrics.webContentsTotal, 0);
  assert.equal(metrics.nativeBrowsers.live, 0);
  assert.equal(metrics.terminals.live, 0);
  assert.equal(metrics.powerTier, 'interactive');
});

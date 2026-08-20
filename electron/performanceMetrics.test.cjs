const test = require('node:test');
const assert = require('node:assert');

const { createPerformanceMetricsCollector } = require('./performanceMetrics.cjs');

test('collector reports injected PTY and WebContents counts with process health', () => {
  const { collect } = createPerformanceMetricsCollector({
    countPtys: () => 3,
    listWebContents: () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  });

  const metrics = collect();
  assert.equal(metrics.ptys, 3);
  assert.equal(metrics.webContentsTotal, 4);
  assert.ok(Number.isFinite(metrics.timestamp));
  assert.ok(metrics.memory.rssBytes > 0);
  assert.ok(metrics.memory.heapUsedBytes > 0);
  assert.ok(metrics.cpu.userMs >= 0);
  assert.ok(metrics.cpu.systemMs >= 0);
});

test('collector accumulates CPU against its construction baseline', async () => {
  const { collect } = createPerformanceMetricsCollector({ countPtys: () => 0 });
  const before = collect().cpu.userMs;
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) {
    // Burn a little user CPU so the delta is visible.
    for (let index = 0; index < 1e6; index += 1) void index * 2;
    if (collect().cpu.userMs > before) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(collect().cpu.userMs >= before);
});

test('collector tolerates missing accessors', () => {
  const { collect } = createPerformanceMetricsCollector();
  const metrics = collect();
  assert.equal(metrics.ptys, 0);
  assert.equal(metrics.webContentsTotal, 0);
});

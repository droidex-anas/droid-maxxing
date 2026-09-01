// Electron main-process performance gauges. Accessors are injected so the
// collector is unit-testable without Electron or node-pty.

function createPerformanceMetricsCollector({
  countPtys,
  listWebContents,
  nativeBrowserCounts,
  terminalCounts,
  powerTier,
  onSample,
} = {}) {
  const cpuBaseline = process.cpuUsage();

  function collect() {
    const webContentsList = typeof listWebContents === 'function' ? listWebContents() : [];
    const cpu = process.cpuUsage(cpuBaseline);
    const memory = process.memoryUsage();
    const metrics = {
      timestamp: Date.now(),
      webContentsTotal: webContentsList.length,
      ptys: typeof countPtys === 'function' ? countPtys() : 0,
      nativeBrowsers:
        typeof nativeBrowserCounts === 'function'
          ? nativeBrowserCounts()
          : { total: 0, live: 0, attached: 0, warm: 0, serialized: 0, maxLive: 0, idleMs: 0 },
      terminals:
        typeof terminalCounts === 'function'
          ? terminalCounts()
          : { live: 0, retained: 0, total: 0 },
      powerTier: typeof powerTier === 'function' ? powerTier() : 'interactive',
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
      cpu: {
        userMs: Math.round(cpu.user / 1000),
        systemMs: Math.round(cpu.system / 1000),
      },
    };
    if (typeof onSample === 'function') onSample(metrics);
    return metrics;
  }

  return { collect };
}

module.exports = { createPerformanceMetricsCollector };

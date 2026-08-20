// Electron main-process performance gauges for perf phase 0 (#116): live
// WebContents, live PTYs, and process memory/CPU. Accessors are injected so
// the collector is unit-testable without Electron or node-pty.

function createPerformanceMetricsCollector({ countPtys, listWebContents } = {}) {
  const cpuBaseline = process.cpuUsage();

  function collect() {
    const webContentsList = typeof listWebContents === 'function' ? listWebContents() : [];
    const cpu = process.cpuUsage(cpuBaseline);
    const memory = process.memoryUsage();
    return {
      timestamp: Date.now(),
      webContentsTotal: webContentsList.length,
      ptys: typeof countPtys === 'function' ? countPtys() : 0,
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
  }

  return { collect };
}

module.exports = { createPerformanceMetricsCollector };

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
      // Cumulative since the collector was constructed (the baseline is
      // captured once, above). Consumers polling on a timer must difference
      // consecutive samples to derive a per-interval rate.
      cpu: {
        userMs: Math.round(cpu.user / 1000),
        systemMs: Math.round(cpu.system / 1000),
      },
    };
  }

  return { collect };
}

module.exports = { createPerformanceMetricsCollector };

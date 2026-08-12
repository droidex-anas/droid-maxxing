const DEFAULT_RECOVERY_DELAY_MS = 400;
const DEFAULT_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RECOVERIES = 2;

function isRendererMemoryExit(details, platform = process.platform) {
  return (
    details?.reason === 'oom' ||
    details?.reason === 'memory-eviction' ||
    (platform === 'darwin' && details?.reason === 'crashed' && details?.exitCode === 5)
  );
}

function createRendererOomRecovery(options = {}) {
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancelScheduled = options.cancelScheduled || clearTimeout;
  const recoveryDelayMs = options.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
  const maxRecoveries = options.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
  const platform = options.platform || process.platform;
  let recoveryTimes = [];
  let pendingTimer = null;

  return {
    handle(details, reload) {
      if (!isRendererMemoryExit(details, platform)) return false;
      if (pendingTimer !== null) return true;

      const at = now();
      recoveryTimes = recoveryTimes.filter((recoveredAt) => at - recoveredAt < recoveryWindowMs);
      if (recoveryTimes.length >= maxRecoveries) return false;
      recoveryTimes.push(at);

      pendingTimer = schedule(() => {
        pendingTimer = null;
        reload();
      }, recoveryDelayMs);
      pendingTimer?.unref?.();
      return true;
    },

    cancel() {
      if (pendingTimer !== null) cancelScheduled(pendingTimer);
      pendingTimer = null;
    },
  };
}

module.exports = {
  createRendererOomRecovery,
  isRendererMemoryExit,
  DEFAULT_RECOVERY_DELAY_MS,
  DEFAULT_RECOVERY_WINDOW_MS,
  DEFAULT_MAX_RECOVERIES,
};

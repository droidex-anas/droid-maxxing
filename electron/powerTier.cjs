// Owns Electron power/battery plus window visibility for the low-background
// work tier. Productive agent execution is not paused here; callers use the
// tier only to drop informational/UI maintenance work.

const TIERS = ['interactive', 'hidden', 'low-power'];

function resolvePowerTier({ windowVisible, documentVisible, onBattery }) {
  const visible = windowVisible !== false && documentVisible !== false;
  if (visible) return 'interactive';
  return onBattery ? 'low-power' : 'hidden';
}

function createPowerTier(options = {}) {
  const powerMonitor = options.powerMonitor;
  const now = options.now || Date.now;
  const rssPressureBytes = Number(options.rssPressureBytes) || 0;
  let windowVisible = true;
  let onBattery = false;
  let pressureArmed = false;
  const listeners = new Set();
  const pressureListeners = new Set();
  const detachPower = [];

  function emit() {
    const tier = current();
    for (const listener of listeners) listener(tier);
  }

  function current() {
    return resolvePowerTier({ windowVisible, documentVisible: true, onBattery });
  }

  function snapshot() {
    return { tier: current(), windowVisible, onBattery };
  }

  function setWindowVisible(visible) {
    const next = Boolean(visible);
    if (windowVisible === next) return;
    windowVisible = next;
    emit();
  }

  function setOnBattery(value) {
    const next = Boolean(value);
    if (onBattery === next) return;
    onBattery = next;
    emit();
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onMemoryPressure(listener) {
    pressureListeners.add(listener);
    return () => pressureListeners.delete(listener);
  }

  function noteRss(rssBytes) {
    if (!(rssPressureBytes > 0)) return false;
    const over = rssBytes >= rssPressureBytes;
    if (over && !pressureArmed) {
      pressureArmed = true;
      for (const listener of pressureListeners) listener({ rssBytes, at: now() });
      return true;
    }
    if (!over) pressureArmed = false;
    return false;
  }

  function attachWindow(win) {
    if (!win || typeof win.on !== 'function') return () => {};
    const hide = () => setWindowVisible(false);
    const show = () => setWindowVisible(true);
    win.on('hide', hide);
    win.on('show', show);
    win.on('minimize', hide);
    win.on('restore', show);
    if (typeof win.isVisible === 'function')
      setWindowVisible(win.isVisible() && !win.isMinimized?.());
    return () => {
      win.off?.('hide', hide);
      win.off?.('show', show);
      win.off?.('minimize', hide);
      win.off?.('restore', show);
    };
  }

  function start() {
    if (!powerMonitor) return () => {};
    try {
      if (typeof powerMonitor.isOnBatteryPower === 'function') {
        onBattery = Boolean(powerMonitor.isOnBatteryPower());
      }
    } catch {
      onBattery = false;
    }
    const battery = () => setOnBattery(true);
    const ac = () => setOnBattery(false);
    if (typeof powerMonitor.on === 'function') {
      powerMonitor.on('on-battery', battery);
      powerMonitor.on('on-ac', ac);
      detachPower.push(() => {
        powerMonitor.off?.('on-battery', battery);
        powerMonitor.off?.('on-ac', ac);
      });
    }
    return () => {
      for (const detach of detachPower.splice(0)) detach();
    };
  }

  return {
    current,
    snapshot,
    setWindowVisible,
    setOnBattery,
    onChange,
    onMemoryPressure,
    noteRss,
    attachWindow,
    start,
  };
}

module.exports = { createPowerTier, resolvePowerTier, TIERS };

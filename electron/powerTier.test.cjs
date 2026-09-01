const test = require('node:test');
const assert = require('node:assert/strict');

const { createPowerTier, resolvePowerTier } = require('./powerTier.cjs');

test('visible windows stay interactive even on battery', () => {
  assert.equal(
    resolvePowerTier({ windowVisible: true, documentVisible: true, onBattery: true }),
    'interactive',
  );
  assert.equal(
    resolvePowerTier({ windowVisible: true, documentVisible: false, onBattery: false }),
    'hidden',
  );
  assert.equal(
    resolvePowerTier({ windowVisible: false, documentVisible: true, onBattery: true }),
    'low-power',
  );
  assert.equal(
    resolvePowerTier({ windowVisible: false, documentVisible: true, onBattery: false }),
    'hidden',
  );
});

test('window hide and battery combine into the low-background-work tier', () => {
  const events = [];
  const power = createPowerTier();
  power.onChange((tier) => events.push(tier));
  assert.equal(power.current(), 'interactive');
  power.setWindowVisible(false);
  assert.equal(power.current(), 'hidden');
  power.setOnBattery(true);
  assert.equal(power.current(), 'low-power');
  power.setWindowVisible(true);
  assert.equal(power.current(), 'interactive');
  assert.deepEqual(events, ['hidden', 'low-power', 'interactive']);
});

test('memory pressure fires once per crossing and resets when RSS drops', () => {
  const hits = [];
  const power = createPowerTier({ rssPressureBytes: 100, now: () => 7 });
  power.onMemoryPressure((event) => hits.push(event));
  assert.equal(power.noteRss(50), false);
  assert.equal(power.noteRss(100), true);
  assert.equal(power.noteRss(200), false);
  assert.equal(power.noteRss(20), false);
  assert.equal(power.noteRss(150), true);
  assert.deepEqual(hits, [
    { rssBytes: 100, at: 7 },
    { rssBytes: 150, at: 7 },
  ]);
});

test('powerMonitor battery listeners update the tier without a second owner', () => {
  const handlers = {};
  const powerMonitor = {
    isOnBatteryPower: () => true,
    on(event, handler) {
      handlers[event] = handler;
    },
    off(event) {
      delete handlers[event];
    },
  };
  const power = createPowerTier({ powerMonitor });
  const stop = power.start();
  assert.equal(power.snapshot().onBattery, true);
  power.setWindowVisible(false);
  assert.equal(power.current(), 'low-power');
  handlers['on-ac']();
  assert.equal(power.current(), 'hidden');
  stop();
  assert.equal(handlers['on-battery'], undefined);
});

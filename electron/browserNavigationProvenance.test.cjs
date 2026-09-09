const assert = require('node:assert/strict');
const test = require('node:test');
const {
  agentNavigationAutonomy,
  consumeTrustedUserNavigation,
  createTrustedUserNavigation,
} = require('./browserNavigationProvenance.cjs');

test('an exact trusted physical navigation is consumed once for its owning browser document', () => {
  const view = {};
  const capability = createTrustedUserNavigation({
    activationId: 'physical-click-1',
    browserSessionId: 'browser-1',
    destinationUrl: 'https://accounts.example/sign-in',
    view,
    navigationGeneration: 4,
    documentGeneration: 7,
    issuedAt: 1_000,
  });

  const transition = {
    browserSessionId: 'browser-1',
    destinationUrl: 'https://accounts.example/sign-in',
    view,
    navigationGeneration: 4,
    documentGeneration: 7,
    now: 1_100,
  };
  assert.equal(consumeTrustedUserNavigation(capability, transition), true);
  assert.equal(consumeTrustedUserNavigation(capability, transition), false);
});

test('a mismatched destination consumes the physical navigation without blessing a later transition', () => {
  const view = {};
  const capability = createTrustedUserNavigation({
    activationId: 'physical-click-2',
    browserSessionId: 'browser-1',
    destinationUrl: 'https://safe.example/',
    view,
    navigationGeneration: 2,
    documentGeneration: 3,
    issuedAt: 2_000,
  });
  const transition = {
    browserSessionId: 'browser-1',
    destinationUrl: 'https://attacker.example/',
    view,
    navigationGeneration: 2,
    documentGeneration: 3,
    now: 2_100,
  };

  assert.equal(consumeTrustedUserNavigation(capability, transition), false);
  assert.equal(
    consumeTrustedUserNavigation(capability, {
      ...transition,
      destinationUrl: 'https://safe.example/',
    }),
    false,
  );
});

test('physical navigation expires and cannot cross browser, view, or document boundaries', () => {
  const view = {};
  const base = {
    activationId: 'physical-click-3',
    browserSessionId: 'browser-1',
    destinationUrl: 'https://safe.example/',
    view,
    navigationGeneration: 8,
    documentGeneration: 13,
    issuedAt: 3_000,
  };
  const expected = {
    browserSessionId: 'browser-1',
    destinationUrl: 'https://safe.example/',
    view,
    navigationGeneration: 8,
    documentGeneration: 13,
    now: 3_100,
  };

  for (const mismatch of [
    { browserSessionId: 'browser-2' },
    { view: {} },
    { navigationGeneration: 9 },
    { documentGeneration: 14 },
    { now: 5_000 },
  ]) {
    assert.equal(
      consumeTrustedUserNavigation(createTrustedUserNavigation(base), {
        ...expected,
        ...mismatch,
      }),
      false,
    );
  }
});

test('out-of-band page transitions cannot inherit stale agent autonomy', () => {
  assert.equal(agentNavigationAutonomy({ autonomy: 'high' }), 'high');
  assert.equal(agentNavigationAutonomy(null), 'low');
  assert.equal(agentNavigationAutonomy(undefined), 'low');
});

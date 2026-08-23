const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowserWebAuthnController } = require('./browserWebAuthn.cjs');

function fixture(options = {}) {
  const handlers = new Map();
  const prompts = [];
  const responses = [...(options.responses || [])];
  const configured = [];
  const browserSession = {
    on: (name, handler) => handlers.set(name, handler),
  };
  const controller = createBrowserWebAuthnController({
    app: {
      configureWebAuthn: (input) => configured.push(input),
    },
    platform: options.platform || 'darwin',
    isPackaged: options.isPackaged ?? true,
    keychainAccessGroup:
      options.keychainAccessGroup === undefined
        ? 'A1B2C3D4E5.app.droidex.webauthn'
        : options.keychainAccessGroup,
    getSession: () => browserSession,
    showMessageBox: async (prompt) => {
      prompts.push(prompt);
      if (options.promptError) throw options.promptError;
      return { response: responses.shift() ?? prompt.cancelId };
    },
  });
  return { browserSession, configured, controller, handlers, prompts };
}

function frame(url = 'https://login.example/account') {
  return {
    url,
    parent: null,
    detached: false,
    processId: 7,
    routingId: 9,
  };
}

function accountDetails(overrides = {}) {
  return {
    relyingPartyId: 'login.example',
    frame: frame(),
    accounts: [
      { credentialId: 'credential-one', name: 'alice@example.com', displayName: 'Alice' },
      { credentialId: 'credential-two', name: 'bob@example.com', displayName: 'Bob' },
    ],
    ...overrides,
  };
}

test('signed mac release configures Team-scoped Touch ID and reports it truthfully', () => {
  const { configured, controller } = fixture();
  controller.initialize();

  assert.deepEqual(configured, [
    {
      touchID: {
        keychainAccessGroup: 'A1B2C3D4E5.app.droidex.webauthn',
        promptReason: 'sign in to $1',
      },
    },
  ]);
  assert.deepEqual(controller.capability(), {
    accountSelectionAvailable: true,
    touchIdPasskeysAvailable: true,
    touchIdPasskeysReason: 'available',
  });
});

test('development and unsigned packages never claim or configure Touch ID passkeys', () => {
  for (const input of [
    { isPackaged: false },
    { keychainAccessGroup: '' },
    { keychainAccessGroup: 'NOT_A_TEAM_GROUP' },
  ]) {
    const { configured, controller } = fixture(input);
    controller.initialize();
    assert.deepEqual(configured, []);
    assert.equal(controller.capability().touchIdPasskeysAvailable, false);
    assert.equal(controller.capability().touchIdPasskeysReason, 'signed_release_required');
  }
});

test('WebAuthn account selection is native, cancel-default, and returns only the chosen ID', async () => {
  const { controller, handlers, prompts } = fixture({ responses: [1] });
  controller.initialize();
  const selections = [];

  await handlers.get('select-webauthn-account')({}, accountDetails(), (credentialId) => {
    selections.push(credentialId ?? null);
  });

  assert.deepEqual(selections, ['credential-two']);
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].buttons, [
    'Alice — alice@example.com',
    'Bob — bob@example.com',
    'Cancel',
  ]);
  assert.equal(prompts[0].defaultId, 2);
  assert.equal(prompts[0].cancelId, 2);
  assert.equal(JSON.stringify(prompts[0]).includes('credential-one'), false);
});

test('WebAuthn account selection cancels denial, prompt failure, stale frame, and wrong RP origin', async () => {
  const cases = [
    { fixture: { responses: [2] }, mutate: () => {}, details: accountDetails() },
    {
      fixture: { promptError: new Error('window closed') },
      mutate: () => {},
      details: accountDetails(),
    },
    {
      fixture: { responses: [0] },
      details: accountDetails(),
      mutate: (details) => {
        details.frame.detached = true;
      },
    },
    {
      fixture: { responses: [0] },
      mutate: () => {},
      details: accountDetails({ relyingPartyId: 'attacker.example' }),
    },
  ];

  for (const input of cases) {
    const { controller, handlers } = fixture(input.fixture);
    controller.initialize();
    const selections = [];
    const promise = handlers.get('select-webauthn-account')({}, input.details, (credentialId) => {
      selections.push(credentialId ?? null);
    });
    input.mutate(input.details);
    await promise;
    assert.deepEqual(selections, [null]);
  }
});

test('WebAuthn account selection rejects cross-origin iframe and malformed credential IDs', async () => {
  for (const details of [
    accountDetails({ frame: { ...frame(), parent: {} } }),
    accountDetails({ accounts: [{ credentialId: 'not base64!' }] }),
  ]) {
    const { controller, handlers, prompts } = fixture({ responses: [0] });
    controller.initialize();
    const selections = [];
    await handlers.get('select-webauthn-account')({}, details, (credentialId) => {
      selections.push(credentialId ?? null);
    });
    assert.deepEqual(selections, [null]);
    assert.deepEqual(prompts, []);
  }
});

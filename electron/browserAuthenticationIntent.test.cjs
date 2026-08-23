const assert = require('node:assert/strict');
const test = require('node:test');
const {
  authenticationPopupTarget,
  validateAgentAuthenticationIntent,
} = require('./browserAuthenticationIntent.cjs');

test('agent authentication rejects cross-origin iframe controls at every autonomy level', () => {
  for (const autonomy of ['off', 'low', 'medium', 'high']) {
    assert.throws(
      () =>
        validateAgentAuthenticationIntent(
          {
            kind: 'cross_origin_frame',
            origin: 'https://app.example',
            targetOrigin: 'https://accounts.example',
          },
          'https://app.example/login',
          autonomy,
        ),
      /Cross-origin frame authentication is blocked/,
    );
  }
});

test('agent authentication rejects stale or wrong-origin intent', () => {
  assert.throws(
    () =>
      validateAgentAuthenticationIntent(
        { kind: 'signin', origin: 'https://old.example' },
        'https://current.example/login',
        'medium',
      ),
    /origin changed/,
  );
});

test('OAuth popup authorization requires an authoritative exact destination', () => {
  const intent = validateAgentAuthenticationIntent(
    {
      kind: 'oauth',
      origin: 'https://app.example',
      targetUrl: 'https://accounts.example/authorize?client=droidex',
    },
    'https://app.example/login',
    'medium',
  );
  assert.equal(
    authenticationPopupTarget(intent),
    'https://accounts.example/authorize?client=droidex',
  );
  assert.throws(
    () =>
      authenticationPopupTarget(
        validateAgentAuthenticationIntent(
          { kind: 'oauth', origin: 'https://app.example' },
          'https://app.example/login',
          'medium',
        ),
      ),
    /destination could not be verified/,
  );
});

test('passkey authentication never grants a web popup', () => {
  const intent = validateAgentAuthenticationIntent(
    { kind: 'passkey', origin: 'https://app.example' },
    'https://app.example/login',
    'high',
  );
  assert.equal(authenticationPopupTarget(intent), undefined);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PROVIDER_ERROR_MESSAGE_CHARS,
  parseProviderError,
  providerErrorCodeSchema,
  providerErrorSchema,
  providerRecoveryActionSchema,
  sanitizeProviderErrorMessage,
} from './providerErrors.js';

const PROVIDER_ERROR_CODES = [
  'invalid_provider_configuration',
  'missing_executable',
  'unauthenticated_provider',
  'unsupported_provider_version',
  'unavailable_provider_instance',
  'unsupported_capability',
  'native_session_start_failed',
  'incompatible_provider_protocol',
  'provider_process_exited',
  'interaction_cancelled',
  'stale_provider_operation',
  'canonical_persistence_unavailable',
] as const;

const PROVIDER_RECOVERY_ACTIONS = [
  'refresh',
  'open_droid_setup',
  'open_codex_setup',
  'open_claude_setup',
  'reset_canonical_state',
  'retry_session',
  'close_session',
] as const;

function validError(overrides: Record<string, unknown> = {}) {
  return {
    code: 'missing_executable',
    providerInstanceId: 'droid',
    message: 'Droid CLI not found',
    recoveryAction: 'open_droid_setup',
    ...overrides,
  };
}

test('all 12 ProviderErrorCode values decode', () => {
  assert.equal(PROVIDER_ERROR_CODES.length, 12);
  for (const code of PROVIDER_ERROR_CODES) {
    assert.equal(providerErrorCodeSchema.parse(code), code);
    assert.deepEqual(
      parseProviderError(validError({ code, recoveryAction: 'refresh' })).code,
      code,
    );
  }
});

test('unknown ProviderErrorCode values are rejected', () => {
  assert.throws(() => providerErrorCodeSchema.parse('provider_timeout'));
  assert.throws(() => parseProviderError(validError({ code: 'provider_timeout' })));
});

test('only the 7 ProviderRecoveryAction values decode', () => {
  assert.equal(PROVIDER_RECOVERY_ACTIONS.length, 7);
  for (const recoveryAction of PROVIDER_RECOVERY_ACTIONS) {
    assert.equal(providerRecoveryActionSchema.parse(recoveryAction), recoveryAction);
    assert.deepEqual(
      parseProviderError(validError({ recoveryAction })).recoveryAction,
      recoveryAction,
    );
  }
});

test('unknown ProviderRecoveryAction values are rejected', () => {
  assert.throws(() => providerRecoveryActionSchema.parse('restart_provider'));
  assert.throws(() => parseProviderError(validError({ recoveryAction: 'restart_provider' })));
});

test('ProviderError rejects raw native error objects and extra payload fields', () => {
  assert.throws(() =>
    providerErrorSchema.parse({
      ...validError(),
      nativeError: { message: 'boom', stack: 'trace' },
    }),
  );
  assert.throws(() =>
    providerErrorSchema.parse({
      ...validError(),
      stack: 'Error: boom\n    at main',
    }),
  );
  assert.throws(() =>
    providerErrorSchema.parse({
      ...validError(),
      cause: new Error('native'),
    }),
  );
});

test('ProviderError round-trips sanitized messages', () => {
  assert.deepEqual(parseProviderError(validError()), {
    code: 'missing_executable',
    providerInstanceId: 'droid',
    message: 'Droid CLI not found',
    recoveryAction: 'open_droid_setup',
  });
  assert.equal(
    parseProviderError(validError({ message: '  needs\x07setup  ' })).message,
    'needssetup',
  );
});

test('over-long ProviderError messages are rejected', () => {
  const tooLong = 'x'.repeat(MAX_PROVIDER_ERROR_MESSAGE_CHARS + 1);
  assert.throws(() => parseProviderError(validError({ message: tooLong })));
});

test('sanitizeProviderErrorMessage strips control characters and trims whitespace', () => {
  assert.equal(sanitizeProviderErrorMessage('\n ok \t'), 'ok');
  assert.equal(sanitizeProviderErrorMessage('\x00bad\x1F'), 'bad');
});

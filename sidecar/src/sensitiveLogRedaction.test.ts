import assert from 'node:assert/strict';
import test from 'node:test';

import { REDACTED, redactSensitiveText, sanitizeForLog } from './sensitiveLogRedaction.js';

export const SENTINEL_TOKEN = 'sk-ant-api03-SENTINEL_TOKEN_VALUE_9f3a2b1c';
export const SENTINEL_API_KEY = 'fac_live_SENTINEL_API_KEY_VALUE_7e8d9c';
export const SENTINEL_CREDENTIAL_HOME = '/Users/ada/.claude/credentials.json';
export const SENTINEL_ACCOUNT_PAYLOAD =
  '{"accountId":"acct_SENTINEL_RAW_ACCOUNT","email":"ada@factory.example"}';

function serializedContainsNone(value: unknown, sentinels: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of sentinels) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `serialized output still contains ${sentinel}`,
    );
  }
}

test('redactSensitiveText redacts a token embedded mid-string', () => {
  assert.equal(
    redactSensitiveText(`probe failed token=${SENTINEL_TOKEN} remaining`),
    `probe failed token=${REDACTED} remaining`,
  );
});

test('redactSensitiveText redacts an API key assignment and a bare key', () => {
  assert.equal(
    redactSensitiveText(`FACTORY_API_KEY=${SENTINEL_API_KEY}`),
    `FACTORY_API_KEY=${REDACTED}`,
  );
  assert.equal(redactSensitiveText(`catalog ${SENTINEL_API_KEY} ok`), `catalog ${REDACTED} ok`);
});

test('redactSensitiveText redacts a Bearer credential', () => {
  assert.equal(
    redactSensitiveText(`Authorization: Bearer ${SENTINEL_TOKEN}`),
    `Authorization: Bearer ${REDACTED}`,
  );
});

test('redactSensitiveText redacts a credential home path inside an error message', () => {
  assert.equal(
    redactSensitiveText(`ENOENT: no such file ${SENTINEL_CREDENTIAL_HOME}`),
    `ENOENT: no such file ${REDACTED}`,
  );
  assert.equal(
    redactSensitiveText('failed to read ~/.codex/auth.json'),
    `failed to read ${REDACTED}`,
  );
});

test('redactSensitiveText redacts a raw account payload', () => {
  assert.equal(redactSensitiveText(`account=${SENTINEL_ACCOUNT_PAYLOAD}`), `account=${REDACTED}`);
});

test('sanitizeForLog redacts sensitive object fields and nested strings', () => {
  const sanitized = sanitizeForLog({
    type: 'provider.probe',
    token: SENTINEL_TOKEN,
    apiKey: SENTINEL_API_KEY,
    credentialHome: SENTINEL_CREDENTIAL_HOME,
    rawAccount: SENTINEL_ACCOUNT_PAYLOAD,
    nested: {
      authorization: `Bearer ${SENTINEL_TOKEN}`,
      message: `stderr wrote ${SENTINEL_TOKEN} from ${SENTINEL_CREDENTIAL_HOME}`,
    },
  });

  assert.deepEqual(sanitized, {
    type: 'provider.probe',
    token: REDACTED,
    apiKey: REDACTED,
    credentialHome: REDACTED,
    rawAccount: REDACTED,
    nested: {
      authorization: REDACTED,
      message: `stderr wrote ${REDACTED} from ${REDACTED}`,
    },
  });
  serializedContainsNone(sanitized, [
    SENTINEL_TOKEN,
    SENTINEL_API_KEY,
    SENTINEL_CREDENTIAL_HOME,
    SENTINEL_ACCOUNT_PAYLOAD,
  ]);
});

test('sanitizeForLog redacts sentinels inside a serialized log line', () => {
  const line = sanitizeForLog(
    `probe ${SENTINEL_TOKEN} FACTORY_API_KEY=${SENTINEL_API_KEY} home=${SENTINEL_CREDENTIAL_HOME} account=${SENTINEL_ACCOUNT_PAYLOAD}`,
  );
  assert.equal(typeof line, 'string');
  serializedContainsNone(line, [
    SENTINEL_TOKEN,
    SENTINEL_API_KEY,
    SENTINEL_CREDENTIAL_HOME,
    SENTINEL_ACCOUNT_PAYLOAD,
  ]);
});

test('sanitizeForLog keeps cycles from leaking raw objects', () => {
  const event: Record<string, unknown> = { type: 'provider.updated' };
  event.self = event;
  assert.deepEqual(sanitizeForLog(event), {
    type: 'provider.updated',
    self: '[Circular]',
  });
});

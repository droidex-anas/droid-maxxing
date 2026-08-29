import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCompleteCapabilities } from '../testing/ProviderContractHarness.js';
import {
  GROK_ACP_CLIENT_INFO,
  GROK_AUTH_METHOD_API_KEY,
  GROK_AUTH_METHOD_CACHED_TOKEN,
  GROK_DEFAULT_BINARY,
  GROK_DEFAULT_SPAWN_ARGS,
  GROK_DEFINITION,
  GROK_OAUTH2_REFERRER,
  GROK_SPAWN_ARGS_BY_AUTONOMY,
  buildGrokAcpSpawn,
  buildGrokHandshake,
  grokCapabilities,
  isValidGrokModelToken,
  parseGrokResumeState,
  resolveGrokAcpBaseModelId,
  resolveGrokAuthMethodId,
} from './grokHandshake.js';

test('spawn argv is a data table keyed by autonomy', () => {
  assert.deepEqual(
    [...GROK_SPAWN_ARGS_BY_AUTONOMY.off],
    ['--permission-mode', 'default', 'agent', 'stdio'],
  );
  assert.deepEqual(
    [...GROK_SPAWN_ARGS_BY_AUTONOMY.low],
    ['--permission-mode', 'acceptEdits', 'agent', 'stdio'],
  );
  assert.deepEqual(
    [...GROK_SPAWN_ARGS_BY_AUTONOMY.medium],
    ['--permission-mode', 'auto', 'agent', 'stdio'],
  );
  assert.deepEqual([...GROK_SPAWN_ARGS_BY_AUTONOMY.high], ['agent', '--always-approve', 'stdio']);
  assert.deepEqual([...GROK_DEFAULT_SPAWN_ARGS], ['agent', 'stdio']);
});

test('buildGrokAcpSpawn uses the default binary, DROIDEX referrer, and autonomy argv', () => {
  const spawn = buildGrokAcpSpawn({
    cwd: '/tmp/project',
    env: { GROK_OAUTH2_REFERRER: 't3code', XAI_API_KEY: 'secret' },
    autonomy: 'off',
  });
  assert.equal(spawn.command, GROK_DEFAULT_BINARY);
  assert.deepEqual(spawn.args, [...GROK_SPAWN_ARGS_BY_AUTONOMY.off]);
  assert.equal(spawn.env?.GROK_OAUTH2_REFERRER, GROK_OAUTH2_REFERRER);
  assert.equal(GROK_OAUTH2_REFERRER, 'droidex');
  assert.equal(
    buildGrokAcpSpawn({ binaryPath: '/usr/local/bin/grok', cwd: '/tmp/project' }).command,
    '/usr/local/bin/grok',
  );
});

test('auth method is xai.api_key when XAI_API_KEY is present, otherwise cached_token', () => {
  assert.equal(resolveGrokAuthMethodId({ XAI_API_KEY: 'sk-test' }), GROK_AUTH_METHOD_API_KEY);
  assert.equal(resolveGrokAuthMethodId({ XAI_API_KEY: '  ' }), GROK_AUTH_METHOD_CACHED_TOKEN);
  assert.equal(resolveGrokAuthMethodId({}), GROK_AUTH_METHOD_CACHED_TOKEN);
});

test('handshake sends truthful DROIDEX client info', () => {
  const handshake = buildGrokHandshake({
    cwd: '/tmp/project',
    env: { XAI_API_KEY: 'sk' },
    resumeSessionId: 'sess-1',
  });
  assert.equal(handshake.authMethodId, GROK_AUTH_METHOD_API_KEY);
  assert.deepEqual(handshake.clientInfo, GROK_ACP_CLIENT_INFO);
  assert.equal(GROK_ACP_CLIENT_INFO.name, 'DROIDEX');
  assert.equal(handshake.resumeSessionId, 'sess-1');
});

test('model tokens match the Grok regex and reject a bad id', () => {
  assert.equal(isValidGrokModelToken('grok-build'), true);
  assert.equal(isValidGrokModelToken('xhigh'), true);
  assert.equal(isValidGrokModelToken('not a token'), false);
  assert.equal(isValidGrokModelToken('-leading-dash'), false);
  assert.equal(isValidGrokModelToken('x'.repeat(33)), false);
  assert.equal(resolveGrokAcpBaseModelId(undefined), 'grok-build');
  assert.equal(resolveGrokAcpBaseModelId('  grok-4.6  '), 'grok-4.6');
});

test('resume state requires schemaVersion 1', () => {
  assert.deepEqual(parseGrokResumeState({ schemaVersion: 1, sessionId: 'abc' }), {
    schemaVersion: 1,
    sessionId: 'abc',
  });
  assert.equal(parseGrokResumeState({ schemaVersion: 2, sessionId: 'abc' }), undefined);
});

test('capability record is complete and truthful', () => {
  const capabilities = grokCapabilities();
  assertCompleteCapabilities(capabilities);
  assert.deepEqual(capabilities.modes, ['auto']);
  assert.deepEqual(capabilities.autonomyLevels, ['off', 'low', 'medium', 'high']);
  assert.equal(capabilities.modelChange, 'before_turn');
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.steer, false);
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.approvals, true);
  assert.equal(capabilities.questions, true);
  assert.equal(capabilities.planReview, true);
  assert.equal(capabilities.usageReporting, false);
  assert.equal(capabilities.reasoningStream, false);
  assert.deepEqual(GROK_DEFINITION, {
    providerDriverKind: 'grok',
    providerInstanceId: 'grok',
    displayName: 'Grok',
  });
});

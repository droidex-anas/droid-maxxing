import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACP_NORMAL_MODE_ALIASES,
  ACP_PLAN_MODE_ALIASES,
  CURSOR_ACP_CLIENT_INFO,
  CURSOR_AUTH_METHOD_ID,
  CURSOR_CLIENT_CAPABILITIES,
  CURSOR_DEFAULT_BINARY,
  CURSOR_RESUME_SCHEMA_VERSION,
  buildCursorAcpSpawn,
  buildCursorHandshake,
  cursorCapabilities,
  encodeCursorResumeState,
  findModeByAliases,
  parseAdvertisedModes,
  parseCursorResumeState,
  resolveCursorAcpBaseModelId,
  resolveCursorSessionModeId,
  supportedCursorInteractionModes,
} from './cursorHandshake.js';
import { assertCompleteCapabilities } from '../testing/ProviderContractHarness.js';

test('spawn is cursor-agent acp, with optional -e endpoint', () => {
  assert.deepEqual(buildCursorAcpSpawn({ cwd: '/tmp/project' }), {
    command: CURSOR_DEFAULT_BINARY,
    args: ['acp'],
    cwd: '/tmp/project',
  });
  assert.deepEqual(
    buildCursorAcpSpawn({
      binaryPath: '/usr/local/bin/agent',
      apiEndpoint: 'http://localhost:3000',
      cwd: '/tmp/project',
    }),
    {
      command: '/usr/local/bin/agent',
      args: ['-e', 'http://localhost:3000', 'acp'],
      cwd: '/tmp/project',
    },
  );
});

test('handshake sends truthful DROIDEX client info and cursor_login', () => {
  const handshake = buildCursorHandshake({ cwd: '/tmp/project', resumeSessionId: 'sess-1' });
  assert.equal(handshake.authMethodId, CURSOR_AUTH_METHOD_ID);
  assert.deepEqual(handshake.clientInfo, CURSOR_ACP_CLIENT_INFO);
  assert.equal(CURSOR_ACP_CLIENT_INFO.name, 'DROIDEX');
  assert.notEqual(CURSOR_ACP_CLIENT_INFO.name.toLowerCase().includes('t3'), true);
  assert.deepEqual(handshake.clientCapabilities, CURSOR_CLIENT_CAPABILITIES);
  assert.equal(CURSOR_CLIENT_CAPABILITIES._meta.parameterizedModelPicker, true);
  assert.equal(handshake.resumeSessionId, 'sess-1');
});

test('bracketed model slugs strip to the base id before session/set_model', () => {
  assert.equal(
    resolveCursorAcpBaseModelId('gpt-5.4-medium-fast[reasoning=medium,context=272k]'),
    'gpt-5.4-medium-fast',
  );
  assert.equal(resolveCursorAcpBaseModelId('gpt-5.4-medium-fast'), 'gpt-5.4-medium-fast');
  assert.equal(resolveCursorAcpBaseModelId(undefined), 'default');
  assert.equal(resolveCursorAcpBaseModelId('  '), 'default');
});

test('resume state is exactly schemaVersion 1 plus sessionId', () => {
  assert.deepEqual(encodeCursorResumeState('abc'), {
    schemaVersion: CURSOR_RESUME_SCHEMA_VERSION,
    sessionId: 'abc',
  });
  assert.deepEqual(parseCursorResumeState({ schemaVersion: 1, sessionId: 'abc' }), {
    schemaVersion: 1,
    sessionId: 'abc',
  });
  assert.equal(parseCursorResumeState({ schemaVersion: 2, sessionId: 'abc' }), undefined);
  assert.equal(parseCursorResumeState({ sessionId: 'abc' }), undefined);
});

test('mode aliases match advertised modes case-insensitively and never invent a mode', () => {
  const advertised = [
    { id: 'Plan', name: 'Architect Mode' },
    { id: 'CODE', name: 'Implementation' },
  ];
  assert.equal(findModeByAliases(advertised, ACP_PLAN_MODE_ALIASES)?.id, 'Plan');
  assert.equal(findModeByAliases(advertised, ACP_NORMAL_MODE_ALIASES)?.id, 'CODE');
  assert.equal(resolveCursorSessionModeId('spec', advertised), 'Plan');
  assert.equal(resolveCursorSessionModeId('auto', advertised), 'CODE');
  assert.equal(resolveCursorSessionModeId('agi', advertised), undefined);
  assert.equal(resolveCursorSessionModeId('spec', [{ id: 'code', name: 'Code' }]), undefined);
  assert.deepEqual(supportedCursorInteractionModes(advertised), ['auto', 'spec']);
  assert.deepEqual(supportedCursorInteractionModes([{ id: 'ask', name: 'Ask' }]), []);
});

test('capability record is complete and truthful for this slice', () => {
  const capabilities = cursorCapabilities(['auto', 'spec']);
  assertCompleteCapabilities(capabilities);
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.modelChange, 'before_turn');
  assert.equal(capabilities.steer, false);
  assert.equal(capabilities.usageReporting, false);
  assert.equal(capabilities.reasoningStream, false);
  assert.equal(capabilities.approvals, true);
  assert.equal(capabilities.questions, true);
  assert.equal(capabilities.planReview, true);
  assert.deepEqual(capabilities.autonomyLevels, ['off', 'low', 'medium', 'high']);
});

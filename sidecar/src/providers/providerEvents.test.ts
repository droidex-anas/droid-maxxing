import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitProviderRuntimeEvent,
  decodeAdmittedProviderRuntimeEvent,
  parseProviderRuntimeEvent,
  serializedProviderEventBytes,
  type ProviderEventAdmissionLive,
  type ProviderRuntimeEvent,
} from './providerEvents.js';
import type { ProviderTurnSettlement } from './providerTypes.js';

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
  'open_cursor_setup',
  'open_grok_setup',
  'reset_canonical_state',
  'retry_session',
  'close_session',
] as const;

const TARGET = { kind: 'session' as const, appSessionId: 'app-1' };

function baseFields(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1',
    target: TARGET,
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 3,
    createdAt: 1_000,
    turnId: 'turn-1',
    ...overrides,
  };
}

function warningEvent(overrides: Record<string, unknown> = {}): ProviderRuntimeEvent {
  return parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'warning',
    message: 'early output',
    ...overrides,
  });
}

function live(overrides: Partial<ProviderEventAdmissionLive> = {}): ProviderEventAdmissionLive {
  return {
    target: TARGET,
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 3,
    settledTurnIds: new Set<string>(),
    ...overrides,
  };
}

test('every ProviderRuntimeEvent variant round-trips through the strict decoder', () => {
  const transcript = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'transcript',
    event: { role: 'primary', kind: 'text', text: 'hello' },
  });
  const usage = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'usage',
    inputTokens: 1,
    outputTokens: 2,
    contextTokens: 3,
  });
  const effect = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'session.effect',
    effect: { kind: 'resume_state', resumeState: { cursor: 'opaque' } },
  });
  const binding = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'binding.updated',
    binding: { providerSessionId: 'native-1', resumeState: { cursor: 'opaque' } },
  });
  const settled = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'turn.settled',
    settlement: { status: 'completed' },
  });
  const warning = warningEvent();
  const error = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'error',
    error: {
      code: 'provider_process_exited',
      providerInstanceId: 'droid',
      message: 'exited',
      recoveryAction: 'retry_session',
    },
  });

  assert.equal(transcript.type, 'transcript');
  assert.equal(usage.type, 'usage');
  assert.equal(effect.type, 'session.effect');
  assert.equal(binding.type, 'binding.updated');
  if (binding.type === 'binding.updated') {
    assert.deepEqual(binding.binding.resumeState, { cursor: 'opaque' });
  }
  assert.equal(settled.type, 'turn.settled');
  assert.equal(warning.type, 'warning');
  assert.equal(error.type, 'error');
});

test('missing runtimeGeneration is rejected', () => {
  const { runtimeGeneration: _runtimeGeneration, ...missing } = baseFields();
  void _runtimeGeneration;
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...missing,
      type: 'warning',
      message: 'no generation',
    }),
  );
});

test('malformed SessionTarget values are rejected', () => {
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields({
        target: { kind: 'session', appSessionId: 'app-1', parentAppSessionId: 'parent-1' },
      }),
      type: 'warning',
      message: 'mixed target',
    }),
  );
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields({ target: { kind: 'child', childSessionId: 'child-1' } }),
      type: 'warning',
      message: 'incomplete child',
    }),
  );
});

test('raw native payloads and extra envelope fields are rejected', () => {
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'warning',
      message: 'raw',
      raw: { factoryNotification: true },
    }),
  );
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields({
        nativeCorrelation: { sessionId: 'native-1', rawPayload: { token: 'secret' } },
      }),
      type: 'warning',
      message: 'native extra',
    }),
  );
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'error',
      error: new Error('native boom'),
    }),
  );
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'transcript',
      event: {
        role: 'primary',
        kind: 'text',
        text: 'hello',
        id: 'leaked-id',
        appSessionId: 'app-1',
      },
    }),
  );
});

test('all 12 error codes decode on error events and unknown codes do not', () => {
  assert.equal(PROVIDER_ERROR_CODES.length, 12);
  for (const code of PROVIDER_ERROR_CODES) {
    const event = parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'error',
      error: {
        code,
        providerInstanceId: 'droid',
        message: `diagnostic for ${code}`,
        recoveryAction: 'refresh',
      },
    });
    assert.equal(event.type, 'error');
    if (event.type === 'error') {
      assert.equal(event.error.code, code);
    }
  }
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'error',
      error: {
        code: 'provider_timeout',
        providerInstanceId: 'droid',
        message: 'unknown',
        recoveryAction: 'refresh',
      },
    }),
  );
});

test('only the 9 recovery actions decode and unknown actions do not', () => {
  assert.equal(PROVIDER_RECOVERY_ACTIONS.length, 9);
  for (const recoveryAction of PROVIDER_RECOVERY_ACTIONS) {
    const event = parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'error',
      error: {
        code: 'unavailable_provider_instance',
        providerInstanceId: 'cursor',
        message: `action ${recoveryAction}`,
        recoveryAction,
      },
    });
    assert.equal(event.type, 'error');
    if (event.type === 'error') {
      assert.equal(event.error.recoveryAction, recoveryAction);
    }
  }
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'error',
      error: {
        code: 'unavailable_provider_instance',
        providerInstanceId: 'droid',
        message: 'unknown action',
        recoveryAction: 'restart_provider',
      },
    }),
  );
});

test('error events sanitize diagnostics and reject extra native error fields', () => {
  const event = parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'error',
    error: {
      code: 'native_session_start_failed',
      providerInstanceId: 'droid',
      message: '  failed\x07open  ',
      recoveryAction: 'retry_session',
    },
  });
  assert.equal(event.type, 'error');
  if (event.type === 'error') {
    assert.equal(event.error.message, 'failedopen');
  }
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'error',
      error: {
        code: 'native_session_start_failed',
        providerInstanceId: 'droid',
        message: 'failed',
        recoveryAction: 'retry_session',
        stack: 'Error: boom',
        nativeError: { cause: true },
      },
    }),
  );
});

test('stale generation, wrong instance, wrong session, and settled-turn events are rejected', () => {
  const event = warningEvent();
  assert.deepEqual(admitProviderRuntimeEvent(event, live({ runtimeGeneration: 2 })), {
    ok: false,
    reason: 'stale_generation',
  });
  assert.deepEqual(admitProviderRuntimeEvent(event, live({ providerInstanceId: 'codex' })), {
    ok: false,
    reason: 'wrong_instance',
  });
  assert.deepEqual(admitProviderRuntimeEvent(event, live({ providerDriverKind: 'codex' })), {
    ok: false,
    reason: 'wrong_driver',
  });
  assert.deepEqual(
    admitProviderRuntimeEvent(event, live({ target: { kind: 'session', appSessionId: 'app-2' } })),
    { ok: false, reason: 'wrong_session' },
  );
  assert.deepEqual(
    admitProviderRuntimeEvent(event, live({ settledTurnIds: new Set(['turn-1']) })),
    { ok: false, reason: 'turn_already_settled' },
  );
  assert.deepEqual(admitProviderRuntimeEvent(event, live()), { ok: true });
});

test('decodeAdmittedProviderRuntimeEvent fails closed for a stale generation', () => {
  assert.throws(() =>
    decodeAdmittedProviderRuntimeEvent(warningEvent(), live({ runtimeGeneration: 9 })),
  );
});

test('serializedProviderEventBytes measures UTF-8 bytes not JS string length', () => {
  const ascii = warningEvent({ message: 'a' });
  const multibyte = warningEvent({ eventId: 'evt-2', message: 'é' });
  assert.equal(
    serializedProviderEventBytes(ascii),
    Buffer.byteLength(JSON.stringify(ascii), 'utf8'),
  );
  assert.ok(serializedProviderEventBytes(multibyte) > JSON.stringify(multibyte).length);
});

test('turn.settled payloads are the closed settlement union', () => {
  const completed: ProviderTurnSettlement = { status: 'completed' };
  const interrupted: ProviderTurnSettlement = { status: 'interrupted' };
  parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'turn.settled',
    settlement: completed,
  });
  parseProviderRuntimeEvent({
    ...baseFields(),
    type: 'turn.settled',
    settlement: interrupted,
  });
  assert.throws(() =>
    parseProviderRuntimeEvent({
      ...baseFields(),
      type: 'turn.settled',
      settlement: { status: 'completed', extra: true },
    }),
  );
});

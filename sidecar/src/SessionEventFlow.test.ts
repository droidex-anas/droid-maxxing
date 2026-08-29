import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionEventFlow,
  type NormalizedSideEffects,
  type NormalizedTokenUsage,
} from './SessionEventFlow.js';
import type { TranscriptEvent } from './protocol.js';
import {
  parseProviderRuntimeEvent,
  type ProviderEventAdmissionLive,
} from './providers/providerEvents.js';

function createHarness(options: { flushError?: Error } = {}) {
  const transcripts: TranscriptEvent[] = [];
  const sideEffects: Array<{
    appSessionId: string;
    value: NormalizedSideEffects;
  }> = [];
  const usage: Array<{
    appSessionId: string;
    sourceProviderSessionId: string;
    value: NormalizedTokenUsage;
  }> = [];
  const trace: string[] = [];
  const eventFlow = new SessionEventFlow({
    appendTranscript: (event) => {
      trace.push(`append:${event.kind}`);
      transcripts.push(event);
    },
    flushTranscript: (appSessionId, sourceSessionId) => {
      trace.push(`flush:${appSessionId}:${sourceSessionId}`);
      if (options.flushError) throw options.flushError;
    },
    applySideEffects: (appSessionId, value) => {
      trace.push(`side:${sideEffectKind(value)}`);
      sideEffects.push({ appSessionId, value });
    },
    recordUsage: (appSessionId, sourceProviderSessionId, value) => {
      trace.push('usage:tokens');
      usage.push({ appSessionId, sourceProviderSessionId, value });
    },
  });
  return { eventFlow, sideEffects, trace, transcripts, usage };
}

function sideEffectKind(sideEffects: NormalizedSideEffects): string {
  if (sideEffects.childSession) return 'child';
  if (sideEffects.features) return 'features';
  if (sideEffects.progress) return 'progress';
  if (sideEffects.missionState) return 'missionState';
  if (sideEffects.missionChild) return 'missionChild';
  return 'unknown';
}

function admission(
  overrides: Partial<ProviderEventAdmissionLive> = {},
): ProviderEventAdmissionLive {
  return {
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 1,
    settledTurnIds: new Set<string>(),
    ...overrides,
  };
}

function providerTranscript(
  overrides: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
) {
  return parseProviderRuntimeEvent({
    eventId: 'evt-1',
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 1,
    createdAt: 1,
    type: 'transcript',
    event: { role: 'primary', kind: 'text', text: 'hello', ...eventOverrides },
    ...overrides,
  });
}

test('apply rejects raw native payload fields before persistence', () => {
  const harness = createHarness();
  harness.eventFlow.apply({ ...providerTranscript(), raw: { native: true } }, admission());
  harness.eventFlow.apply({ ...providerTranscript(), nativePayload: {} }, admission());
  harness.eventFlow.apply({ ...providerTranscript(), sdkEvent: {} }, admission());
  assert.equal(harness.transcripts.length, 0);
});

test('apply rejects wrong target, instance, session, and generation', () => {
  const harness = createHarness();
  harness.eventFlow.apply(
    providerTranscript({ target: { kind: 'session', appSessionId: 'other' } }),
    admission(),
  );
  harness.eventFlow.apply(providerTranscript({ providerInstanceId: 'codex' }), admission());
  harness.eventFlow.apply(providerTranscript({ providerDriverKind: 'codex' }), admission());
  harness.eventFlow.apply(providerTranscript({ runtimeGeneration: 9 }), admission());
  assert.equal(harness.transcripts.length, 0);
});

test('apply rejects a duplicate event id', () => {
  const harness = createHarness();
  const event = providerTranscript();
  harness.eventFlow.apply(event, admission());
  harness.eventFlow.apply(event, admission());
  assert.equal(harness.transcripts.length, 1);
  assert.equal(harness.transcripts[0]?.text, 'hello');
});

test('apply drops post-terminal generated output', () => {
  const harness = createHarness();
  harness.eventFlow.apply(
    parseProviderRuntimeEvent({
      eventId: 'settled',
      target: { kind: 'session', appSessionId: 'app-1' },
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      runtimeGeneration: 1,
      createdAt: 1,
      type: 'turn.settled',
      settlement: { status: 'completed' },
    }),
    admission(),
  );
  harness.eventFlow.apply(
    providerTranscript({ eventId: 'late' }, { text: 'must be dropped' }),
    admission(),
  );
  assert.equal(harness.transcripts.length, 0);
});

test('apply still records a failed Task child after the source is terminal', () => {
  const harness = createHarness();
  harness.eventFlow.apply(
    parseProviderRuntimeEvent({
      eventId: 'settled',
      target: { kind: 'session', appSessionId: 'app-1' },
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      runtimeGeneration: 1,
      createdAt: 1,
      type: 'turn.settled',
      settlement: { status: 'completed' },
    }),
    admission(),
  );
  harness.eventFlow.apply(
    providerTranscript(
      { eventId: 'failed-task' },
      { kind: 'tool_result', toolName: 'Task', toolUseId: 'task-1', text: 'worker failed', isError: true },
    ),
    admission(),
  );
  assert.equal(harness.transcripts[0]?.isError, true);
  assert.equal(harness.sideEffects[0]?.value.childSession?.done, true);
});

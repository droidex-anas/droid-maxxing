import assert from 'node:assert/strict';
import test from 'node:test';

import type { TranscriptEvent } from './protocol.js';
import {
  envelopesAreByteEquivalent,
  liftRendererTranscriptEvent,
  parseCanonicalEvent,
  parseCanonicalEventPayload,
  projectTranscriptEvent,
  searchAuthorForPayload,
  searchTextForPayload,
  type CanonicalEvent,
  type CanonicalEventPayload,
  type CanonicalIdentity,
  type PersistedCanonicalEvent,
} from './sessionEvents.js';

const TARGET = { kind: 'session' as const, appSessionId: 'app-1' };
const CHILD_TARGET = {
  kind: 'child' as const,
  parentAppSessionId: 'app-1',
  childSessionId: 'child-1',
};
const IDENTITY: CanonicalIdentity = {
  providerDriverKind: 'droid',
  providerInstanceId: 'droid',
  runtimeGeneration: 3,
};
const PROVIDER_ERROR = {
  code: 'provider_process_exited' as const,
  providerInstanceId: 'droid' as const,
  message: 'exited',
  recoveryAction: 'retry_session' as const,
};

function envelope(payload: CanonicalEventPayload, overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1',
    target: TARGET,
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 3,
    createdAt: 1_000,
    turnId: 'turn-1',
    nativeCorrelation: {
      sessionId: 'native-session',
      turnId: 'native-turn',
      itemId: 'native-item',
    },
    payload,
    ...overrides,
  };
}

function persisted(
  payload: CanonicalEventPayload,
  seq = 7,
  overrides: Record<string, unknown> = {},
): PersistedCanonicalEvent {
  return { ...parseCanonicalEvent(envelope(payload, overrides)), seq };
}

function everyPayload(): CanonicalEventPayload[] {
  return [
    { type: 'session.lifecycle', status: 'started' },
    { type: 'turn.started' },
    { type: 'transcript', transcript: { role: 'primary', kind: 'text', text: 'hello' } },
    { type: 'usage', inputTokens: 1, outputTokens: 2, contextTokens: 3 },
    { type: 'approval.lifecycle', requestId: 'apr-1', status: 'requested' },
    { type: 'question.lifecycle', requestId: 'q-1', status: 'settled' },
    { type: 'plan_review.lifecycle', requestId: 'plan-1', status: 'requested' },
    {
      type: 'session.effect',
      effect: {
        kind: 'context',
        stats: {
          used: 10,
          remaining: 90,
          limit: 100,
          accuracy: 'exact',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      },
    },
    {
      type: 'session.effect',
      effect: { kind: 'compaction', compactType: 'auto', removedCount: 4 },
    },
    {
      type: 'session.effect',
      effect: {
        kind: 'observational_task',
        taskId: 'task-1',
        label: 'scan',
        status: 'running',
      },
    },
    {
      type: 'session.effect',
      effect: {
        kind: 'child_upsert',
        child: {
          parentAppSessionId: 'app-1',
          childSessionId: 'child-1',
          role: 'worker',
          status: 'running',
          modelId: 'model-default',
          transcriptAvailable: true,
          streamFidelity: 'state',
        },
      },
    },
    { type: 'binding.updated', resumeState: { cursor: 'opaque' } },
    { type: 'turn.settled', settlement: { status: 'completed' } },
    { type: 'warning', message: 'early output' },
    { type: 'error', error: PROVIDER_ERROR },
  ];
}

test('every CanonicalEventPayload variant round-trips through the strict decoder', () => {
  for (const payload of everyPayload()) {
    const decoded = parseCanonicalEvent(envelope(payload));
    assert.deepEqual(decoded.payload, parseCanonicalEventPayload(payload));
  }
});

test('decoder rejects unknown payload types, extra keys, and resume_state effects', () => {
  assert.throws(() =>
    parseCanonicalEvent(envelope({ type: 'turn.started' }, { payload: { type: 'plan' } })),
  );
  assert.throws(() =>
    parseCanonicalEvent({
      ...envelope({ type: 'turn.started' }),
      extra: true,
    }),
  );
  assert.throws(() =>
    parseCanonicalEventPayload({
      type: 'session.effect',
      effect: { kind: 'resume_state', resumeState: { cursor: 'opaque' } },
    }),
  );
  assert.throws(() =>
    parseCanonicalEvent({
      ...envelope({ type: 'transcript', transcript: { role: 'primary', kind: 'text' } }),
      payload: {
        type: 'transcript',
        transcript: { role: 'primary', kind: 'text', id: 'renderer-id' },
      },
    }),
  );
});

test('empty nativeCorrelation normalizes to absent', () => {
  const decoded = parseCanonicalEvent(
    envelope({ type: 'turn.started' }, { nativeCorrelation: {} }),
  );
  assert.equal(decoded.nativeCorrelation, undefined);
});

test('projectTranscriptEvent maps eventId/id, event_order/seq, createdAt/ts, and session target', () => {
  const event = persisted({
    type: 'transcript',
    transcript: { role: 'primary', kind: 'text', text: 'hello', endAt: 1_200 },
  });
  const projected = projectTranscriptEvent(event);
  assert.deepEqual(projected, {
    id: 'evt-1',
    appSessionId: 'app-1',
    sourceSessionId: 'app-1',
    role: 'primary',
    ts: 1_000,
    seq: 7,
    kind: 'text',
    text: 'hello',
    endTs: 1_200,
  });
});

test('child targets map to parent appSessionId and child sourceSessionId', () => {
  const event = persisted(
    { type: 'transcript', transcript: { role: 'worker', kind: 'status', text: 'working' } },
    11,
    { target: CHILD_TARGET },
  );
  const projected = projectTranscriptEvent(event);
  assert.equal(projected?.appSessionId, 'app-1');
  assert.equal(projected?.sourceSessionId, 'child-1');
  assert.equal(projected?.role, 'worker');
  assert.equal(projected?.seq, 11);
});

test('provider identity, generation, and native correlation never cross the bridge', () => {
  const event = persisted({
    type: 'transcript',
    transcript: { role: 'primary', kind: 'text', text: 'hello' },
  });
  const projected = projectTranscriptEvent(event);
  assert.ok(projected);
  const keys = Object.keys(projected);
  for (const banned of [
    'providerDriverKind',
    'providerInstanceId',
    'runtimeGeneration',
    'nativeCorrelation',
    'eventId',
    'target',
    'turnId',
  ]) {
    assert.equal(keys.includes(banned), false, banned);
  }
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('native-session'), false);
  assert.equal(serialized.includes('native-turn'), false);
  assert.equal(serialized.includes('native-item'), false);
  assert.equal(serialized.includes('"droid"'), false);
});

test('non-transcript payloads do not project to a renderer transcript', () => {
  for (const payload of everyPayload()) {
    if (payload.type === 'transcript') continue;
    assert.equal(projectTranscriptEvent(persisted(payload)), undefined, payload.type);
  }
});

test('tool payloads round-trip through decode, lift, and projection', () => {
  const toolArgs = { path: '/tmp/file', content: 'body' };
  const decoded = parseCanonicalEvent(
    envelope({
      type: 'transcript',
      transcript: {
        role: 'primary',
        kind: 'tool_call',
        toolName: 'Edit',
        toolUseId: 'tool-1',
        toolArgs,
        isError: false,
      },
    }),
  );
  assert.equal(decoded.payload.type, 'transcript');
  if (decoded.payload.type !== 'transcript') return;
  assert.deepEqual(decoded.payload.transcript.toolArgs, toolArgs);

  const projected = projectTranscriptEvent({ ...decoded, seq: 4 });
  assert.deepEqual(projected?.toolArgs, toolArgs);
  assert.equal(projected?.toolName, 'Edit');
  assert.equal(projected?.toolUseId, 'tool-1');

  const lifted = liftRendererTranscriptEvent(projected as TranscriptEvent, IDENTITY);
  assert.equal(lifted.payload.type, 'transcript');
  if (lifted.payload.type !== 'transcript') return;
  assert.deepEqual(lifted.payload.transcript.toolArgs, toolArgs);
});

test('liftRendererTranscriptEvent is the inverse of projection for session and child text', () => {
  const session = persisted({
    type: 'transcript',
    transcript: { role: 'primary', kind: 'text', text: 'hi', author: 'user' },
  });
  const sessionProjected = projectTranscriptEvent(session);
  assert.ok(sessionProjected);
  const sessionLifted = liftRendererTranscriptEvent(sessionProjected, IDENTITY);
  assert.equal(sessionLifted.eventId, session.eventId);
  assert.deepEqual(sessionLifted.target, TARGET);
  assert.equal(sessionLifted.createdAt, 1_000);
  assert.deepEqual(sessionLifted.payload, session.payload);

  const childProjected = projectTranscriptEvent(
    persisted(
      { type: 'transcript', transcript: { role: 'validator', kind: 'thinking', text: 'hmm' } },
      2,
      { target: CHILD_TARGET },
    ),
  );
  assert.ok(childProjected);
  assert.deepEqual(liftRendererTranscriptEvent(childProjected, IDENTITY).target, CHILD_TARGET);
});

test('search text keeps user and assistant text and excludes tool, thinking, and internal kinds', () => {
  assert.equal(
    searchTextForPayload({
      type: 'transcript',
      transcript: { role: 'primary', kind: 'text', text: 'hello\nthere', author: 'user' },
    }),
    'hello there',
  );
  assert.equal(
    searchAuthorForPayload({
      type: 'transcript',
      transcript: { role: 'primary', kind: 'text', text: 'hello there', author: 'user' },
    }),
    'user',
  );
  assert.equal(
    searchAuthorForPayload({
      type: 'transcript',
      transcript: { role: 'primary', kind: 'text', text: 'reply' },
    }),
    'assistant',
  );
  assert.equal(
    searchTextForPayload({
      type: 'transcript',
      transcript: { role: 'primary', kind: 'thinking', text: 'secret plan' },
    }),
    '',
  );
  assert.equal(
    searchTextForPayload({
      type: 'transcript',
      transcript: { role: 'primary', kind: 'tool_call', text: 'grep secret', toolName: 'Bash' },
    }),
    '',
  );
  assert.equal(
    searchTextForPayload({
      type: 'transcript',
      transcript: { role: 'primary', kind: 'status', text: 'compacting' },
    }),
    '',
  );
  assert.equal(searchTextForPayload({ type: 'warning', message: 'visible warning' }), '');
});

test('byte-equivalent envelopes compare normalized payload key order', () => {
  const left = parseCanonicalEvent(envelope({ type: 'usage', outputTokens: 2, inputTokens: 1 }));
  const right: CanonicalEvent = parseCanonicalEvent(
    envelope({ type: 'usage', inputTokens: 1, outputTokens: 2 }),
  );
  assert.equal(envelopesAreByteEquivalent(left, right), true);
  assert.equal(
    envelopesAreByteEquivalent(left, { ...right, createdAt: right.createdAt + 1 }),
    false,
  );
});

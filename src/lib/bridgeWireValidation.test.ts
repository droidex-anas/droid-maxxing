import assert from 'node:assert/strict';
import test from 'node:test';

import { serverWireMessage } from './bridgeWireValidation';
import { droidSessionConfiguration } from './sessionConfiguration';

function batch(event: unknown): unknown {
  return {
    type: 'events.batch',
    generation: 'generation-1',
    firstSeq: 1,
    lastSeq: 1,
    events: [{ seq: 1, event }],
  };
}

test('rejects approval requests with unknown permission kinds', () => {
  assert.equal(
    serverWireMessage(
      batch({
        type: 'approval.requested',
        request: {
          appSessionId: 'app-1',
          requestId: 'permission-1',
          kind: 'unknown-permission',
          title: 'Approve action',
          detail: 'Run the requested action.',
        },
      }),
    ),
    null,
  );
});

test('rejects search results that omit the indexing completeness flag', () => {
  assert.equal(
    serverWireMessage(
      batch({
        type: 'sessions.searchResults',
        requestId: 'req-1',
        results: [],
      }),
    ),
    null,
  );
  assert.ok(
    serverWireMessage(
      batch({
        type: 'sessions.searchResults',
        requestId: 'req-1',
        results: [],
        indexingIncomplete: false,
      }),
    ),
  );
});

test('rejects malformed features in session summaries and mission updates', () => {
  const malformedFeature = { status: 'pending' };
  const session = {
    appSessionId: 'app-1',
    sessionPurpose: 'mission-control',
    role: 'primary',
    title: 'Mission',
    goal: 'Ship safely',
    cwd: '/repo',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'agi',
      autonomy: 'high',
    }),
    phase: 'running',
    features: [malformedFeature],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  assert.equal(serverWireMessage(batch({ type: 'session.updated', session })), null);
  assert.equal(
    serverWireMessage(
      batch({ type: 'mission.features', appSessionId: 'app-1', features: [malformedFeature] }),
    ),
    null,
  );
});

test('rejects object payloads that are actually arrays', () => {
  assert.equal(serverWireMessage(batch({ type: 'settings.defaults', defaults: [] })), null);
  assert.ok(serverWireMessage(batch({ type: 'settings.defaults', defaults: {} })));
  assert.equal(
    serverWireMessage(
      batch({
        type: 'sessions.searchResults',
        requestId: 'req-1',
        results: [[]],
        indexingIncomplete: false,
      }),
    ),
    null,
  );
});

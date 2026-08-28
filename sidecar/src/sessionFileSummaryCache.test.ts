import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCachedSessionSummary,
  serializeCachedSessionSummary,
} from './sessionFileSummaryCache.js';
import type { SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

function summary(): SessionSummary {
  return {
    appSessionId: 'app',
    providerSessionId: 'provider',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Valid cached session',
    goal: 'Validate derived rows',
    cwd: '/repo',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 1,
    tokensOut: 2,
    contextTokens: 3,
    createdAt: 4,
    updatedAt: 5,
  };
}

test('cached session summaries accept the complete canonical contract', () => {
  const value = summary();
  assert.deepEqual(parseCachedSessionSummary(serializeCachedSessionSummary(value)), value);
});

test('cached session summaries reject malformed required arrays and discriminants', () => {
  const missingFeatures = { ...summary(), features: undefined };
  const invalidPhase = { ...summary(), phase: 'sleeping' };
  const invalidConfiguration = {
    ...summary(),
    configuration: { ...summary().configuration, autonomy: 'extreme' },
  };
  const invalidAccuracy = { ...summary(), contextAccuracy: 'guessed' };
  const invalidWorkspace = { ...summary(), workspaceKind: 'repository' };
  assert.equal(
    parseCachedSessionSummary(JSON.stringify({ cacheVersion: 1, summary: missingFeatures })),
    undefined,
  );
  assert.equal(
    parseCachedSessionSummary(JSON.stringify({ cacheVersion: 1, summary: invalidPhase })),
    undefined,
  );
  for (const invalid of [invalidConfiguration, invalidAccuracy, invalidWorkspace]) {
    assert.equal(
      parseCachedSessionSummary(JSON.stringify({ cacheVersion: 1, summary: invalid })),
      undefined,
    );
  }
});

test('inherited Object.prototype keys are not restored as configuration enums', () => {
  const inherited = {
    ...summary(),
    configuration: { ...summary().configuration, autonomy: 'toString' },
  };
  assert.equal(
    parseCachedSessionSummary(JSON.stringify({ cacheVersion: 1, summary: inherited })),
    undefined,
  );
});

test('only SQL NULL represents an intentionally excluded session summary', () => {
  assert.equal(parseCachedSessionSummary(null), null);
  for (const corruptValue of [undefined, 1, new Uint8Array([1, 2, 3]), {}]) {
    assert.equal(parseCachedSessionSummary(corruptValue), undefined);
  }
});

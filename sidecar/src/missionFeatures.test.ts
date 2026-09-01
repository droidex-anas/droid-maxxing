import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeFeature } from './missionFeatures.js';

test('bridgeFeature passes a well-formed feature through unchanged', () => {
  const feature = {
    id: 'f1',
    description: 'Ship the thing',
    status: 'in_progress',
    skillName: 'build',
    preconditions: ['a'],
    expectedBehavior: ['b'],
    verificationSteps: ['c'],
    fulfills: ['req-1'],
    milestone: 'M1',
  };
  assert.deepEqual(bridgeFeature(feature), feature);
});

test('bridgeFeature omits fulfills and milestone when the source has none', () => {
  const feature = bridgeFeature({
    id: 'f2',
    description: 'Validate the thing',
    status: 'completed',
    skillName: 'verify',
  });
  assert.deepEqual(feature, {
    id: 'f2',
    description: 'Validate the thing',
    status: 'completed',
    skillName: 'verify',
    preconditions: [],
    expectedBehavior: [],
    verificationSteps: [],
  });
  assert.equal('fulfills' in feature, false);
  assert.equal('milestone' in feature, false);
});

test('bridgeFeature repairs an unrecognized status instead of leaking it', () => {
  assert.equal(bridgeFeature({ id: 'f3', status: 'blocked' }).status, 'pending');
});

test('bridgeFeature drops non-string entries from list fields', () => {
  assert.deepEqual(bridgeFeature({ id: 'f4', preconditions: ['a', 7, null] }).preconditions, ['a']);
  assert.deepEqual(bridgeFeature({ id: 'f4', fulfills: 'req-1' }).fulfills, undefined);
});

test('bridgeFeature yields a valid feature for unreadable JSON', () => {
  assert.deepEqual(bridgeFeature(null), {
    id: 'feature',
    description: 'Feature',
    status: 'pending',
    skillName: '',
    preconditions: [],
    expectedBehavior: [],
    verificationSteps: [],
  });
});

test('bridgeFeature falls back to the id when a description is missing', () => {
  assert.equal(bridgeFeature({ id: 'f5' }).description, 'f5');
});

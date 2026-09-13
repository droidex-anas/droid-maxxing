import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAlwaysOutcome,
  isApprovalOutcome,
  normalizePermissionOutcome,
} from './permissionOutcomes.js';

test('the MCP always-allow alias folds onto a plain always-allow grant', () => {
  assert.equal(normalizePermissionOutcome('proceed_always_tools'), 'proceed_always');
  assert.equal(isAlwaysOutcome('proceed_always_tools'), true);
  assert.equal(isApprovalOutcome('proceed_always_tools'), true);
});

test('cancel is the only outcome that is not an approval', () => {
  assert.equal(normalizePermissionOutcome('cancel'), 'cancel');
  assert.equal(isApprovalOutcome('cancel'), false);
  assert.equal(isAlwaysOutcome('cancel'), false);
});

test('rejects unknown permission outcomes before they reach a provider', () => {
  assert.throws(() => normalizePermissionOutcome('always_yes'), /Unsupported permission outcome/);
  assert.equal(isAlwaysOutcome('always_yes'), false);
});

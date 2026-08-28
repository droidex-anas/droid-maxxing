import assert from 'node:assert/strict';
import test from 'node:test';

import { grokPermissionFingerprint, selectGrokPermissionOptionId } from './grokPermissions.js';

const options = [
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'reject-once', kind: 'reject_once' },
];

test('permission option mapping prefers allow_always and falls back to allow_once', () => {
  assert.equal(selectGrokPermissionOptionId(options, 'allow_session'), 'allow-once');
  assert.equal(
    selectGrokPermissionOptionId(
      [...options, { optionId: 'allow-always', kind: 'allow_always' }],
      'allow_session',
    ),
    'allow-always',
  );
  assert.equal(selectGrokPermissionOptionId(options, 'allow_once'), 'allow-once');
  assert.equal(selectGrokPermissionOptionId(options, 'deny'), 'reject-once');
});

test('permission fingerprints match the same operation and ignore bash descriptions', () => {
  const first = grokPermissionFingerprint({
    kind: 'execute',
    title: 'Terminal',
    command: 'ls',
    rawInput: { variant: 'Bash', command: 'ls', description: 'list files' },
  });
  const second = grokPermissionFingerprint({
    kind: 'execute',
    title: 'Terminal',
    command: 'ls',
    rawInput: { variant: 'Bash', command: 'ls', description: 'other' },
  });
  const other = grokPermissionFingerprint({
    kind: 'execute',
    title: 'Terminal',
    command: 'rm',
    rawInput: { variant: 'Bash', command: 'rm' },
  });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(
    grokPermissionFingerprint({ kind: 'execute', title: 'Terminal', rawInput: {} }),
    undefined,
  );
});

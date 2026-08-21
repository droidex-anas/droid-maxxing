import assert from 'node:assert/strict';
import test from 'node:test';

import { githubAuthCodeCopyResult } from './useGithubAuthCodeCopy';

test('only the latest clipboard attempt can publish its result', () => {
  assert.equal(githubAuthCodeCopyResult(1, 2, 'ABCD-1234', false), null);
  assert.deepEqual(githubAuthCodeCopyResult(2, 2, 'ABCD-1234', true), {
    copiedCode: 'ABCD-1234',
    copyFailedCode: null,
  });
  assert.deepEqual(githubAuthCodeCopyResult(2, 2, 'ABCD-1234', false), {
    copiedCode: null,
    copyFailedCode: 'ABCD-1234',
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { followAcpPrompt } from './acpPromptFollow.js';

test('followAcpPrompt does not run handlers before startTurn-equivalent work returns', async () => {
  let accepted = false;
  const seen: string[] = [];
  const promptPromise = Promise.resolve({ stopReason: 'end_turn' });
  followAcpPrompt(promptPromise, {
    onResult: () => {
      seen.push(accepted ? 'after-accept' : 'before-accept');
    },
    onError: () => {
      seen.push('error');
    },
  });
  accepted = true;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seen, ['after-accept']);
});

test('followAcpPrompt routes rejection to onError exactly once', async () => {
  const calls: unknown[] = [];
  followAcpPrompt(Promise.reject(new Error('boom')), {
    onResult: (result) => calls.push(['result', result]),
    onError: (error) => calls.push(['error', error]),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(Array.isArray(calls[0]) && calls[0][0], 'error');
});

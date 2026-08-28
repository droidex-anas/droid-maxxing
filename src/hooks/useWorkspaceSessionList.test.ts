import assert from 'node:assert/strict';
import test from 'node:test';

import { withRevealedCwds } from './useWorkspaceSessionList';

test('revealing a folder adds every execution cwd it can run sessions in', () => {
  const revealed = withRevealedCwds([], ['/repo/app', '/repo/app/.worktrees/feature-a']);

  assert.deepEqual([...revealed], ['/repo/app', '/repo/app/.worktrees/feature-a']);
});

test('revealing a second folder keeps the first revealed', () => {
  const revealed = withRevealedCwds(['/repo/app'], ['/repo/api']);

  assert.deepEqual([...revealed], ['/repo/app', '/repo/api']);
});

test('revealing an already revealed folder does not re-request the list', () => {
  const revealed = ['/repo/app', '/repo/api'];

  assert.equal(withRevealedCwds(revealed, ['/repo/app']), revealed);
  assert.equal(withRevealedCwds(revealed, []), revealed);
});

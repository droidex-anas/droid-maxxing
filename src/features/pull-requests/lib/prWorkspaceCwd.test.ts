import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePrWorkspaceCwd } from './prWorkspaceCwd';

test('prefers an explicit bind, then a folder session, then the newest workspace', () => {
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: '/bound',
      activeCwd: '/session',
      workspaceKind: 'folder',
      workspaceCwds: ['/recent', '/older'],
    }),
    '/bound',
  );
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: null,
      activeCwd: '/session',
      workspaceKind: 'folder',
      workspaceCwds: ['/recent'],
    }),
    '/session',
  );
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: null,
      activeCwd: '/session',
      workspaceKind: 'none',
      workspaceCwds: ['/recent'],
    }),
    '/recent',
  );
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: null,
      activeCwd: null,
      workspaceKind: undefined,
      workspaceCwds: [],
    }),
    null,
  );
});

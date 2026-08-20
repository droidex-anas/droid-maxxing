import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePrWorkspaceCwd, selectionForPrWorkspace } from './prWorkspaceCwd';

test('prefers an explicit bind, then a folder session, then the newest workspace', () => {
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: '/bound',
      activeCwd: '/session',
      workspaceKind: 'folder',
      workspaceCwds: ['/bound', '/older'],
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

test('keeps a bound cwd that is only the active session folder', () => {
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: '/session',
      activeCwd: '/session',
      workspaceKind: 'folder',
      workspaceCwds: [],
    }),
    '/session',
  );
});

test('drops a bound cwd that is no longer a known workspace', () => {
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: '/removed',
      activeCwd: '/session',
      workspaceKind: 'folder',
      workspaceCwds: ['/recent'],
    }),
    '/session',
  );
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: '/removed',
      activeCwd: '/session',
      workspaceKind: 'none',
      workspaceCwds: ['/recent'],
    }),
    '/recent',
  );
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: '/removed',
      activeCwd: null,
      workspaceKind: undefined,
      workspaceCwds: [],
    }),
    null,
  );
});

test('known folders compare with the app path equivalence rules', () => {
  // Windows separators and drive casing name the same folder.
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: 'C:\\Work\\Repo',
      activeCwd: null,
      workspaceKind: 'folder',
      workspaceCwds: ['c:/work/repo'],
    }),
    'C:\\Work\\Repo',
  );
  assert.equal(
    resolvePrWorkspaceCwd({
      boundCwd: 'c:/work/repo',
      activeCwd: 'C:\\Work\\Repo',
      workspaceKind: 'folder',
      workspaceCwds: [],
    }),
    'c:/work/repo',
  );
});

test('a selected PR is retained only for the effective bound repository', () => {
  assert.equal(selectionForPrWorkspace('/repo', '/repo', 12), 12);
  assert.equal(selectionForPrWorkspace('C:\\Work\\Repo', 'c:/work/repo', 12), 12);
  assert.equal(selectionForPrWorkspace('/removed', '/fallback', 12), null);
  assert.equal(selectionForPrWorkspace(null, '/fallback', 12), null);
});

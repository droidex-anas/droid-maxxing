import assert from 'node:assert/strict';
import test from 'node:test';
import { rowMenuTarget } from './useSidebarRowActions';
import type { SessionSummary } from '../types/bridge';

test('row menus reject missing and hidden targets during render', () => {
  assert.equal(rowMenuTarget({}, { appSessionId: 'gone' }, {}), null);
  const session: SessionSummary = {
    appSessionId: 'chat',
    title: 'Chat',
    goal: '',
    cwd: '/worktree',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    autonomy: 'off',
    phase: 'completed',
    createdAt: 1,
    updatedAt: 1,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
  };
  const sessions = { chat: session };
  assert.equal(rowMenuTarget(sessions, { appSessionId: 'chat' }, {}), session);
  assert.equal(
    rowMenuTarget(sessions, { appSessionId: 'chat' }, { chat: { archivedAt: 1 } }),
    null,
  );
  assert.equal(rowMenuTarget(sessions, { appSessionId: 'chat' }, { chat: { deletedAt: 1 } }), null);
  assert.equal(rowMenuTarget(sessions, null, {}), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptEvent, initialState, reducer } from './useStore';
import type { PermissionRequest, SessionQuestion } from '../types/bridge';

function makePermission(appSessionId: string, kind: PermissionRequest['kind'] = 'exec') {
  const request: PermissionRequest = {
    appSessionId,
    requestId: `req-${appSessionId}`,
    kind,
    title: 'Run command',
    detail: 'rm -rf build',
  };
  const action = adaptEvent({ type: 'approval.requested', request });
  assert.ok(action);
  return action;
}

function makeQuestion(appSessionId: string) {
  const question: SessionQuestion = {
    appSessionId,
    requestId: `req-${appSessionId}`,
    questions: [{ id: '0', prompt: 'Pick one', options: ['a', 'b'], multiSelect: false }],
  };
  const action = adaptEvent({ type: 'question.requested', question });
  assert.ok(action);
  return action;
}

test('permission requests stay scoped to the session that asked', () => {
  const withFirst = reducer(initialState, makePermission('app-1'));
  const withBoth = reducer(withFirst, makePermission('app-2'));

  assert.equal(withBoth.pendingPermissions['app-1']?.requestId, 'req-app-1');
  assert.equal(withBoth.pendingPermissions['app-2']?.requestId, 'req-app-2');
});

test('answering a permission clears only that sessions request', () => {
  const withBoth = reducer(reducer(initialState, makePermission('app-1')), makePermission('app-2'));
  const next = reducer(withBoth, { type: 'CLEAR_PERMISSION', appSessionId: 'app-1' });

  assert.equal(next.pendingPermissions['app-1'], undefined);
  assert.equal(next.pendingPermissions['app-2']?.requestId, 'req-app-2');
});

test('clearing a permission that is not pending leaves other sessions intact', () => {
  const withOne = reducer(initialState, makePermission('app-1'));
  const next = reducer(withOne, { type: 'CLEAR_PERMISSION', appSessionId: 'app-2' });
  assert.equal(next.pendingPermissions['app-1']?.requestId, 'req-app-1');
});

test('a newer permission request replaces the previous one for that session', () => {
  const withOne = reducer(initialState, makePermission('app-1'));
  const replacement = adaptEvent({
    type: 'approval.requested' as const,
    request: {
      appSessionId: 'app-1',
      requestId: 'req-app-1-second',
      kind: 'edit' as const,
      title: 'Edit file',
      detail: 'src/app.ts',
    },
  });
  assert.ok(replacement);
  const next = reducer(withOne, replacement);
  assert.equal(next.pendingPermissions['app-1']?.requestId, 'req-app-1-second');
});

test('questions stay scoped to the session that asked', () => {
  const withFirst = reducer(initialState, makeQuestion('app-1'));
  const withBoth = reducer(withFirst, makeQuestion('app-2'));

  assert.equal(withBoth.pendingQuestions['app-1']?.requestId, 'req-app-1');
  assert.equal(withBoth.pendingQuestions['app-2']?.requestId, 'req-app-2');

  const answered = reducer(withBoth, { type: 'CLEAR_QUESTION', appSessionId: 'app-2' });
  assert.equal(answered.pendingQuestions['app-2'], undefined);
  assert.equal(answered.pendingQuestions['app-1']?.requestId, 'req-app-1');
});

test('closing a session drops its pending permission and question', () => {
  const withPermission = reducer(initialState, makePermission('app-1'));
  const withBoth = reducer(withPermission, makeQuestion('app-1'));
  const next = reducer(withBoth, { type: 'SESSION_CLOSED', appSessionId: 'app-1' });

  assert.equal(next.pendingPermissions['app-1'], undefined);
  assert.equal(next.pendingQuestions['app-1'], undefined);
});

test('a spec permission still seeds the session spec while pending', () => {
  const action = adaptEvent({
    type: 'approval.requested' as const,
    request: {
      appSessionId: 'app-1',
      requestId: 'req-spec',
      kind: 'spec' as const,
      title: 'Plan ready for review',
      detail: '# Plan',
      plan: '# Plan',
    },
  });
  assert.ok(action);
  const next = reducer(initialState, action);

  assert.equal(next.pendingPermissions['app-1']?.kind, 'spec');
  assert.equal(next.sessionSpecs['app-1']?.content, '# Plan');
  assert.equal(next.specPlans['app-1'], '# Plan');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionAttention } from './sessionAttention';
import type { PermissionRequest, SessionQuestion } from '../types/bridge';

function makePermission(appSessionId: string): PermissionRequest {
  return {
    appSessionId,
    requestId: `req-${appSessionId}`,
    kind: 'exec',
    title: 'Run command',
    detail: 'ls',
  };
}

function makeQuestion(appSessionId: string): SessionQuestion {
  return {
    appSessionId,
    requestId: `req-${appSessionId}`,
    questions: [{ id: '0', prompt: 'Pick one', options: ['a', 'b'], multiSelect: false }],
  };
}

test('sessionAttention: a pending approval needs attention', () => {
  assert.equal(sessionAttention('app-1', { 'app-1': makePermission('app-1') }, {}), 'approval');
});

test('sessionAttention: a pending question needs attention', () => {
  assert.equal(sessionAttention('app-1', {}, { 'app-1': makeQuestion('app-1') }), 'question');
});

test('sessionAttention: a pending request from another session does not leak over', () => {
  assert.equal(
    sessionAttention(
      'app-2',
      { 'app-1': makePermission('app-1') },
      { 'app-1': makeQuestion('app-1') },
    ),
    null,
  );
});

test('sessionAttention: approval wins when both are pending', () => {
  assert.equal(
    sessionAttention(
      'app-1',
      { 'app-1': makePermission('app-1') },
      { 'app-1': makeQuestion('app-1') },
    ),
    'approval',
  );
});

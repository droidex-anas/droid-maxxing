import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptEvent, initialState, reducer, toastMessageForEvent } from './useStore';
import type { SessionSummary } from '../types/bridge';

const session: SessionSummary = {
  appSessionId: 'app-1',
  providerSessionId: 'provider-1',
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title: 'Chat',
  goal: '',
  cwd: '',
  workspaceKind: 'none',
  autonomy: 'low',
  phase: 'running',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
};

test('non-open child command failures are routed to user-visible toast feedback', () => {
  const failure = {
    type: 'child.error' as const,
    code: 'child.settings_update_failed',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: null,
    operation: 'settings' as const,
    message: 'Could not update child settings: provider rejected',
  };

  assert.equal(toastMessageForEvent(failure), failure.message);
  assert.deepEqual(adaptEvent(failure), {
    type: 'CHILD_ERROR',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: null,
    operation: 'settings',
    message: failure.message,
  });
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.settings_target_invalid',
    }),
    failure.message,
  );
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.send_failed',
      operation: 'send',
    }),
    failure.message,
  );
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.not_in_session',
      operation: 'loadHistory',
    }),
    failure.message,
  );
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.open_failed',
      operation: 'open',
    }),
    undefined,
  );
});

test('a primary error fails only the primary session', () => {
  const action = adaptEvent({
    type: 'error',
    appSessionId: 'app-1',
    providerSessionId: 'provider-1',
    message: 'resume failed',
  });
  assert.ok(action);

  const state = {
    ...initialState,
    sessions: { 'app-1': session },
  };
  const next = reducer(state, action);

  assert.equal(next.sessions['app-1']?.phase, 'failed');
});

test('a create failure clears only its matching pending first message', () => {
  const withFirst = reducer(initialState, {
    type: 'SET_PENDING_COMPOSE',
    clientRef: 'client-1',
    text: 'first',
    skills: [],
    files: [],
  });
  const withBoth = reducer(withFirst, {
    type: 'SET_PENDING_COMPOSE',
    clientRef: 'client-2',
    text: 'second',
    skills: [],
    files: [],
  });
  const failure = {
    type: 'error' as const,
    code: 'session.create_failed',
    clientRef: 'client-1',
    message: 'Could not create session',
  };
  const action = adaptEvent(failure);
  assert.ok(action);
  assert.deepEqual(action, {
    type: 'SESSION_CREATE_FAILED',
    clientRef: 'client-1',
    message: failure.message,
  });

  const next = reducer(withBoth, action);
  assert.deepEqual(Object.keys(next.pendingCompose), ['client-2']);
  assert.equal(next.pendingCompose['client-2']?.text, 'second');
  assert.equal(next.sessions, withBoth.sessions);
  assert.equal(next.activeAppSessionId, withBoth.activeAppSessionId);
  assert.equal(toastMessageForEvent(failure), failure.message);
});

test('a matching child-open error settles access without failing the parent session', () => {
  const action = adaptEvent({
    type: 'child.error',
    code: 'child.open_failed',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: 'request-1',
    operation: 'open',
    message: 'child failed to open',
  });
  assert.ok(action);

  const state = {
    ...initialState,
    sessions: { 'app-1': session },
    activeAppSessionId: 'app-1',
    selectedChild: { parentAppSessionId: 'app-1', childSessionId: 'child-1' },
    childAccess: { 'app-1': { 'child-1': { state: 'opening', requestId: 'request-1' } } },
  };
  const next = reducer(state, action);

  assert.equal(next.sessions['app-1']?.phase, 'running');
  assert.deepEqual(next.childAccess['app-1']?.['child-1'], {
    state: 'failed',
    requestId: 'request-1',
  });
});

test('a recoverable parent error stays out of reducer state', () => {
  const action = adaptEvent({
    type: 'error',
    appSessionId: 'app-1',
    providerSessionId: 'provider-1',
    message: 'history restore failed',
    recoverable: true,
  });
  assert.equal(action, null);
});

test('a bridge resync requirement becomes an actionable connection error', () => {
  const resync = {
    type: 'error' as const,
    code: 'bridge.resync_required',
    message: 'The renderer fell behind. Reopen the active session to refresh it.',
    recoverable: false,
  };

  assert.equal(toastMessageForEvent(resync), resync.message);
  assert.deepEqual(adaptEvent(resync), {
    type: 'SET_CONNECTION',
    status: 'error',
    message: resync.message,
  });
});

test('a recoverable bridge resync keeps connection state available for reconnect', () => {
  const resync = {
    type: 'error' as const,
    code: 'bridge.resync_required',
    message: 'The runtime sent a malformed batch. Reconnecting with a fresh cursor.',
    recoverable: true,
  };

  assert.equal(toastMessageForEvent(resync), resync.message);
  assert.equal(adaptEvent(resync), null);
});

test('an unsupported-command error toasts its restart guidance', () => {
  // Bridge version skew (e.g. a dev app running across a sidecar rebuild)
  // surfaces as bridge.unsupported_command; the message must reach the user
  // instead of a silent hang.
  const skew = {
    type: 'error' as const,
    code: 'bridge.unsupported_command',
    message:
      'This DROIDEX build does not support the "session.exportMarkdown" command. Restart the app to pick up the current sidecar.',
  };
  assert.equal(toastMessageForEvent(skew), skew.message);
});

test('unflushed history and interrupted sessions toast instead of looking durable', () => {
  const unflushed = {
    type: 'error' as const,
    code: 'history.unflushed_work',
    message: 'The previous agent runtime exited with unflushed history.',
    recoverable: true,
  };
  const interrupted = {
    type: 'error' as const,
    code: 'session.interrupted',
    appSessionId: 'app-1',
    message: 'The agent runtime restarted and this turn did not continue.',
    recoverable: true,
  };
  assert.equal(toastMessageForEvent(unflushed), unflushed.message);
  assert.equal(adaptEvent(unflushed), null);
  assert.equal(toastMessageForEvent(interrupted), interrupted.message);
  assert.equal(adaptEvent(interrupted), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';

test('OPEN_AUTOMATIONS routes to the automations view and closes the session right panel', () => {
  const state = reducer({ ...initialState, rightPanelOpen: true }, { type: 'OPEN_AUTOMATIONS' });
  assert.equal(state.mainView, 'automations');
  assert.equal(state.rightPanelOpen, false);
  assert.equal(state.automationEditorRequest, null);
});

test('an editor request survives until the view reports it handled', () => {
  const requested = reducer(initialState, {
    type: 'OPEN_AUTOMATIONS',
    automationId: 'aut-1',
  });
  const request = requested.automationEditorRequest;
  assert.equal(request?.automationId, 'aut-1');

  // The snapshot may arrive after the view mounts, so unrelated actions must not
  // drop the request before the editor can open.
  const rendered = reducer(requested, { type: 'SET_RIGHT_PANEL', open: false });
  assert.deepEqual(rendered.automationEditorRequest, request);

  const handled = reducer(rendered, {
    type: 'AUTOMATION_EDITOR_REQUEST_HANDLED',
    requestId: request?.requestId ?? -1,
  });
  assert.equal(handled.automationEditorRequest, null);
});

test('requesting the same automation twice re-arms the editor', () => {
  const first = reducer(initialState, { type: 'OPEN_AUTOMATIONS', automationId: 'aut-1' });
  const handled = reducer(first, {
    type: 'AUTOMATION_EDITOR_REQUEST_HANDLED',
    requestId: first.automationEditorRequest?.requestId ?? -1,
  });
  const second = reducer(handled, { type: 'OPEN_AUTOMATIONS', automationId: 'aut-1' });

  assert.equal(second.automationEditorRequest?.automationId, 'aut-1');
  assert.notEqual(
    second.automationEditorRequest?.requestId,
    first.automationEditorRequest?.requestId,
  );

  // A late acknowledgement of the consumed request must not cancel the new one.
  const stale = reducer(second, {
    type: 'AUTOMATION_EDITOR_REQUEST_HANDLED',
    requestId: first.automationEditorRequest?.requestId ?? -1,
  });
  assert.deepEqual(stale.automationEditorRequest, second.automationEditorRequest);
});

test('navigating away closes automations and drops a pending editor request', () => {
  const open = reducer(initialState, { type: 'OPEN_AUTOMATIONS', automationId: 'aut-1' });

  const pullRequests = reducer(open, { type: 'OPEN_PULL_REQUESTS', cwd: '/repo' });
  assert.equal(pullRequests.mainView, 'pull-requests');
  assert.equal(pullRequests.automationEditorRequest, null);

  const draft = reducer(open, { type: 'START_CHAT', cwd: '/repo', executionMode: 'local' });
  assert.equal(draft.mainView, 'session');
  assert.equal(draft.automationEditorRequest, null);

  const session = reducer(open, { type: 'SET_ACTIVE_SESSION', id: 'session-1' });
  assert.equal(session.mainView, 'session');
  assert.equal(session.automationEditorRequest, null);
});

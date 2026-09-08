import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';

test('closing Automations restores the session route and clears an editor request', () => {
  const open = reducer(initialState, {
    type: 'OPEN_AUTOMATIONS',
    automationId: 'automation-1',
  });
  assert.equal(open.mainView, 'automations');
  assert.ok(open.automationEditorRequest);

  const closed = reducer(open, { type: 'CLOSE_AUTOMATIONS' });
  assert.equal(closed.mainView, 'session');
  assert.equal(closed.automationEditorRequest, null);
});

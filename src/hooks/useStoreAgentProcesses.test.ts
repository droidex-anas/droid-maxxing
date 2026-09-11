import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';
import type { AgentProcess } from '../types/bridge';

function process(overrides: Partial<AgentProcess> = {}): AgentProcess {
  return {
    pid: 1,
    name: 'vite',
    command: 'vite',
    startedAt: 0,
    ports: [5173],
    ...overrides,
  };
}

test('session.processes replaces the list and session close clears it', () => {
  const processes = [process()];
  let state = reducer(initialState, {
    type: 'SESSION_PROCESSES',
    appSessionId: 's1',
    processes,
  });
  assert.deepEqual(state.agentProcesses.s1, processes);

  state = reducer(state, { type: 'SESSION_PROCESSES', appSessionId: 's1', processes: [] });
  assert.equal('s1' in state.agentProcesses, false);

  state = reducer(state, { type: 'SESSION_PROCESSES', appSessionId: 's1', processes });
  state = reducer(state, { type: 'SESSION_CLOSED', appSessionId: 's1' });
  assert.equal('s1' in state.agentProcesses, false);
});

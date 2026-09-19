import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer, type AppState } from '../../hooks/useStore';
import { serverWireMessage } from '../../lib/bridgeWireValidation';
import type { SessionSummary } from '../../types/bridge';
import type { ProjectView } from './types';

const project: ProjectView = {
  id: 'project',
  title: 'Build',
  paused: false,
  wakesLeft: 20,
  launching: 0,
  threads: [
    { appSessionId: 'main', title: 'Main', waiting: false },
    { appSessionId: 'worker', ownerAppSessionId: 'main', title: 'Worker', waiting: false },
  ],
  queued: 0,
  uncertain: 0,
  uncertainTargets: [],
};
function wire(event: unknown) {
  return serverWireMessage({
    type: 'events.batch',
    generation: 'test',
    firstSeq: 1,
    lastSeq: 1,
    events: [{ seq: 1, event }],
  });
}
function session(id: string): SessionSummary {
  return {
    appSessionId: id,
    provider: 'droid',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: id,
    goal: '',
    cwd: '/workspace',
    autonomy: 'low',
    phase: 'running',
    streaming: true,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('validated project graphs and explicitly acknowledged results cross the bridge', () => {
  assert.ok(wire({ type: 'projects.snapshot', projects: [project] }));
  assert.ok(wire({ type: 'project.result', requestId: 'request', ok: true, projectId: 'project' }));
  assert.ok(
    wire({ type: 'project.result', requestId: 'request', ok: false, error: 'Disk unavailable' }),
  );
  assert.equal(wire({ type: 'project.result', requestId: 'request' }), null);
  assert.equal(wire({ type: 'project.result', requestId: 'request', ok: false }), null);
});

test('malformed graphs, negative budgets and foreign uncertain targets are rejected', () => {
  assert.equal(
    wire({ type: 'projects.snapshot', projects: [{ ...project, threads: [{}] }] }),
    null,
  );
  assert.equal(
    wire({ type: 'projects.snapshot', projects: [{ ...project, wakesLeft: -1 }] }),
    null,
  );
  assert.equal(
    wire({ type: 'projects.snapshot', projects: [{ ...project, uncertainTargets: ['foreign'] }] }),
    null,
  );
  const cyclic = structuredClone(project);
  cyclic.threads[1].ownerAppSessionId = 'worker';
  assert.equal(wire({ type: 'projects.snapshot', projects: [cyclic] }), null);
  assert.equal(
    wire({ type: 'projects.snapshot', projects: Array.from({ length: 33 }, () => project) }),
    null,
  );
});

test('opening a managed thread uses ordinary activation without stopping its siblings', () => {
  const state: AppState = {
    ...initialState,
    mainView: 'projects',
    activeAppSessionId: 'main',
    sessions: { main: session('main'), worker: session('worker') },
    sessionOrder: ['main', 'worker'],
    selectedChild: null,
  };
  const next = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'worker' });
  assert.equal(next.mainView, 'session');
  assert.equal(next.activeAppSessionId, 'worker');
  assert.equal(next.selectedChild, null);
  assert.equal(next.sessions.main.streaming, true);
  assert.equal(next.sessions.worker.streaming, true);
  assert.equal(next.sessions, state.sessions);
  assert.equal(reducer(next, { type: 'CLOSE_PROJECTS' }).mainView, 'session');
});

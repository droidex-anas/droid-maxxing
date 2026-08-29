import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptEvent, initialState, reducer, type AppState } from './useStore';
import {
  childSessionIsLive,
  shouldOpenSelectedChild,
  visibleSessionTarget,
} from '../lib/childSessions';
import { childStreamPhase } from '../lib/childSessionStream';
import type { ChildSessionSummary, ServerEvent, SessionSummary } from '../types/bridge';
import { droidSessionConfiguration } from '../lib/sessionConfiguration';

const child = (parentAppSessionId: string, childSessionId: string): ChildSessionSummary => ({
  parentAppSessionId,
  childSessionId,
  role: 'worker',
  status: 'paused',
  modelId: 'model-default',
  transcriptAvailable: true,
  streamFidelity: 'state',
});

const session = (appSessionId: string): SessionSummary => ({
  appSessionId,
  sessionPurpose: 'chat',
  role: 'primary',
  title: appSessionId,
  goal: appSessionId,
  cwd: '/workspace',
  configuration: droidSessionConfiguration({
    modelId: 'model-default',
    interactionMode: 'auto',
    autonomy: 'low',
  }),
  phase: 'paused',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
});

function select(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  requestId: string,
): AppState {
  const withParent = {
    ...state,
    activeAppSessionId: parentAppSessionId,
    childSessions: {
      ...state.childSessions,
      [parentAppSessionId]: {
        ...(state.childSessions[parentAppSessionId] ?? {}),
        [childSessionId]: child(parentAppSessionId, childSessionId),
      },
    },
  };
  return reducer(withParent, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId, childSessionId },
    requestId,
  });
}

function dispatchEvent(state: AppState, event: ServerEvent): AppState {
  const action = adaptEvent(event);
  assert.ok(action);
  return reducer(state, action);
}

test('ready and history acknowledgements preserve their discriminated access state', () => {
  let ready = select(initialState, 'parent-a', 'child-a', 'request-ready');
  ready = reducer(ready, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-ready',
    access: 'ready',
    runtimeGeneration: 3,
  });
  assert.deepEqual(ready.childAccess['parent-a']?.['child-a'], {
    state: 'ready',
    requestId: 'request-ready',
    runtimeGeneration: 3,
  });

  let history = select(initialState, 'parent-a', 'child-a', 'request-history');
  history = reducer(history, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-history',
    access: 'history',
  });
  assert.deepEqual(history.childAccess['parent-a']?.['child-a'], {
    state: 'history',
    requestId: 'request-history',
  });
});

test('a stale open result cannot resurrect readiness after selection changes', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(
    {
      ...state,
      childSessions: {
        'parent-a': {
          'child-a': child('parent-a', 'child-a'),
          'child-b': child('parent-a', 'child-b'),
        },
      },
    },
    {
      type: 'SELECT_CHILD',
      selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-b' },
      requestId: 'request-b',
    },
  );
  const afterStale = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 1,
  });

  assert.equal(afterStale, state);
  assert.deepEqual(afterStale.selectedChild, {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-b',
  });
  assert.deepEqual(afterStale.childAccess['parent-a']?.['child-b'], {
    state: 'opening',
    requestId: 'request-b',
  });
});

test('same child IDs under different parents cannot cross-settle', () => {
  const state = select(initialState, 'parent-a', 'shared-child', 'request-a');
  const afterWrongParent = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-b',
    childSessionId: 'shared-child',
    requestId: 'request-a',
    access: 'history',
  });
  assert.equal(afterWrongParent, state);
});

test('live runtime summaries advance generation and stale generations cannot roll it back', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 3,
  });
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 4,
  });
  assert.equal(state.childAccess['parent-a']?.['child-a']?.state, 'ready');
  assert.equal(
    state.childAccess['parent-a']?.['child-a']?.state === 'ready'
      ? state.childAccess['parent-a']?.['child-a'].runtimeGeneration
      : undefined,
    4,
  );

  const stale = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 2,
  });
  assert.deepEqual(stale.childAccess, state.childAccess);
});

test('an unavailable runtime closes only the matching newer live generation', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 1,
  });
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 2,
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('a stale unavailable runtime cannot close a newer reopened runtime', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 4,
  });
  const stale = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });
  assert.deepEqual(stale.childAccess, state.childAccess);
});

test('a late ready acknowledgement cannot resurrect a runtime closed while opening', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 2,
  });
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });
  const afterLateReady = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });

  assert.deepEqual(afterLateReady.childRuntime['parent-a']?.['child-a'], {
    available: false,
    runtimeGeneration: 3,
  });
  assert.deepEqual(afterLateReady.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('leaving an opening child invalidates its request before reselection', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'SELECT_CHILD', selection: null });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
  });
  assert.equal(state.childAccess['parent-a'], undefined);

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    requestId: 'request-b',
  });
  const afterLateReady = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });

  assert.deepEqual(afterLateReady.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-b',
  });
});

test('switching parents invalidates an opening child request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'parent-b' });

  assert.equal(state.selectedChild, null);
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('selecting the already-active parent invalidates an opening child request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'parent-a' });

  assert.equal(state.selectedChild, null);
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('disconnect clears child selection, access, and runtime watermarks', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = {
    ...state,
    contextStats: {
      primary: {
        'parent-a': {
          used: 10,
          remaining: 90,
          limit: 100,
          accuracy: 'exact',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      },
      child: {
        'parent-a': {
          'child-a': {
            used: 20,
            remaining: 80,
            limit: 100,
            accuracy: 'exact',
            updatedAt: '2026-07-30T00:00:00.000Z',
          },
        },
      },
    },
  };
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });
  state = reducer(state, { type: 'SET_CONNECTION', status: 'error', message: 'closed' });

  assert.equal(state.selectedChild, null);
  assert.deepEqual(state.childAccess, {});
  assert.deepEqual(state.childRuntime, {});
  assert.deepEqual(state.contextStats.primary['parent-a']?.used, 10);
  assert.deepEqual(state.contextStats.child, {});
});

test('starting a draft invalidates the selected child open request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'START_CHAT',
    cwd: '/workspace',
    executionMode: 'worktree',
  });

  assert.equal(state.selectedChild, null);
  assert.equal(state.activeAppSessionId, null);
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('creating a new parent invalidates the selected child open request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'SET_PENDING_COMPOSE',
    clientRef: 'new-parent',
    text: 'start parent',
    skills: [],
    files: [],
  });
  state = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'new-parent',
    session: session('parent-b'),
  });

  assert.equal(state.selectedChild, null);
  assert.equal(state.activeAppSessionId, 'parent-b');
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('resuming a background parent does not steal the selected session', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'resume:parent-b',
    session: session('parent-b'),
  });

  assert.equal(state.activeAppSessionId, 'parent-a');
  assert.deepEqual(state.selectedChild, {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-a',
  });
});

test('resuming a historical parent clears its terminal child access state', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'history',
  });
  state = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'resume-parent',
    session: session('parent-a'),
  });

  assert.equal(state.selectedChild, null);
  assert.equal(state.childAccess['parent-a'], undefined);
  assert.equal(state.childRuntime['parent-a'], undefined);
});

test('a stale runtime generation cannot roll back the child summary', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 4,
  });
  const stale = reducer(state, {
    type: 'SESSION_CHILD',
    child: {
      ...child('parent-a', 'child-a'),
      status: 'completed',
      modelId: 'stale-model',
    },
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });

  assert.equal(stale, state);
  assert.equal(stale.childSessions['parent-a']?.['child-a']?.modelId, 'model-default');

  const sameRuntimeUpdate = reducer(state, {
    type: 'SESSION_CHILD',
    child: {
      ...child('parent-a', 'child-a'),
      modelId: 'accepted-model',
    },
    runtimeAvailable: true,
    runtimeGeneration: 4,
  });
  assert.equal(sameRuntimeUpdate.childSessions['parent-a']?.['child-a']?.modelId, 'accepted-model');
});

test('failed child access retries only after explicit reselection', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_ERROR',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    operation: 'open',
    requestId: 'request-a',
    code: 'child.open_failed',
    message: 'failed',
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'failed',
    requestId: 'request-a',
  });

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
  });
  assert.equal(state.childAccess['parent-a'], undefined);

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    requestId: 'request-b',
  });
  const afterLateReady = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });
  assert.deepEqual(afterLateReady.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-b',
  });
});

test('child history errors settle the loading state for retry', () => {
  let state = reducer(initialState, {
    type: 'CHILD_HISTORY_LOADING',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
  });

  state = reducer(state, {
    type: 'CHILD_ERROR',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    operation: 'loadHistory',
    requestId: null,
    message: 'history unavailable',
  });

  assert.deepEqual(state.childHistory['parent-a']?.['child-a'], {
    status: 'failed',
    loadedCount: 0,
    hasMore: false,
    error: 'history unavailable',
    isLoaded: false,
    isLoadingOlder: false,
    olderCursor: undefined,
    isViewportPinned: true,
  });
});

test('canonical child events adapt without provider identity aliases', () => {
  assert.deepEqual(
    adaptEvent({
      type: 'child.updated',
      parentAppSessionId: 'parent-a',
      childSessionId: 'child-a',
      requestId: 'request-a',
      access: 'ready',
      runtimeGeneration: 4,
    }),
    {
      type: 'CHILD_UPDATED',
      parentAppSessionId: 'parent-a',
      childSessionId: 'child-a',
      requestId: 'request-a',
      access: 'ready',
      runtimeGeneration: 4,
    },
  );
});

test('canonical child summaries update only the exact parent-owned child', () => {
  const action = adaptEvent({
    type: 'session.child',
    event: 'upserted',
    child: {
      ...child('parent-a', 'child-a'),
      modelId: 'model-new',
      reasoningEffort: 'high',
    },
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });
  assert.ok(action);
  const state = reducer(initialState, action);

  assert.equal(state.childSessions['parent-a']?.['child-a']?.modelId, 'model-new');
  assert.equal(state.childSessions['parent-a']?.['child-a']?.reasoningEffort, 'high');
  const nativeKey = ['provider', 'SessionId'].join('');
  assert.equal(Object.hasOwn(state.childSessions['parent-a']!['child-a']!, nativeKey), false);
});

test('a selected queued open stays pending and becomes usable when the runtime is admitted', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: { ...child('parent-a', 'child-a'), queued: true },
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });

  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-a',
  });
  assert.equal(state.childSessions['parent-a']?.['child-a']?.queued, true);
  assert.deepEqual(state.childRuntime['parent-a']?.['child-a'], {
    available: false,
    runtimeGeneration: 1,
  });
  assert.equal(
    childStreamPhase({
      queued: state.childSessions['parent-a']?.['child-a']?.queued,
      status: state.childSessions['parent-a']?.['child-a']?.status,
    }),
    'queued',
  );
  assert.equal(
    childSessionIsLive(
      state.childSessions['parent-a']!['child-a']!,
      state.childRuntime['parent-a']?.['child-a'],
    ),
    false,
  );
  assert.equal(shouldOpenSelectedChild(state.childAccess['parent-a']?.['child-a']), false);
  const queuedTarget = visibleSessionTarget(
    'parent-a',
    { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    state.childSessions,
    state.childAccess,
  );
  assert.equal(queuedTarget.kind, 'child');
  if (queuedTarget.kind === 'child') {
    assert.equal(queuedTarget.canSend, false);
    assert.equal(queuedTarget.canInterrupt, false);
    assert.equal(queuedTarget.settingsReadiness, 'opening');
  }

  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-a',
  });

  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 2,
  });
  state = dispatchEvent(state, {
    type: 'child.updated',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });

  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'ready',
    requestId: 'request-a',
    runtimeGeneration: 2,
  });
  assert.deepEqual(state.childRuntime['parent-a']?.['child-a'], {
    available: true,
    runtimeGeneration: 2,
  });
  const readyTarget = visibleSessionTarget(
    'parent-a',
    { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    state.childSessions,
    state.childAccess,
  );
  assert.equal(readyTarget.kind, 'child');
  if (readyTarget.kind === 'child') {
    assert.equal(readyTarget.canSend, true);
    assert.equal(readyTarget.settingsReadiness, 'ready');
  }
});

test('a ready ack cannot resurrect a child whose live runtime already closed', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });
  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });

  const afterStaleReady = dispatchEvent(state, {
    type: 'child.updated',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });
  assert.equal(afterStaleReady, state);
  assert.deepEqual(afterStaleReady.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
  assert.deepEqual(afterStaleReady.childRuntime['parent-a']?.['child-a'], {
    available: false,
    runtimeGeneration: 3,
  });
});

test('stop on a queued child leaves it idle without delivering a later cancelled open', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: { ...child('parent-a', 'child-a'), queued: true, status: 'paused' },
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });
  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: { ...child('parent-a', 'child-a'), status: 'paused' },
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });

  const interrupted = state.childSessions['parent-a']?.['child-a'];
  assert.equal(Boolean(interrupted?.queued), false);
  assert.notEqual(interrupted?.status, 'running');
  assert.equal(
    childSessionIsLive(interrupted!, state.childRuntime['parent-a']?.['child-a']),
    false,
  );
  assert.deepEqual(state.childRuntime['parent-a']?.['child-a'], {
    available: false,
    runtimeGeneration: 1,
  });
});

test('four live children plus one queued selected open becomes usable when admitted', () => {
  let state = initialState;
  for (const id of ['a', 'b', 'c', 'd']) {
    state = select(state, 'parent-a', `child-${id}`, `request-${id}`);
    state = reducer(state, {
      type: 'CHILD_UPDATED',
      parentAppSessionId: 'parent-a',
      childSessionId: `child-${id}`,
      requestId: `request-${id}`,
      access: 'ready',
      runtimeGeneration: 1,
    });
  }
  state = select(state, 'parent-a', 'child-e', 'request-e');
  state = dispatchEvent(state, {
    type: 'session.child',
    event: 'upserted',
    child: { ...child('parent-a', 'child-e'), queued: true },
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });

  assert.equal(state.childAccess['parent-a']?.['child-e']?.state, 'opening');
  assert.equal(state.childSessions['parent-a']?.['child-e']?.queued, true);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(state.childAccess['parent-a']?.[`child-${id}`]?.state, 'ready');
    assert.equal(state.childRuntime['parent-a']?.[`child-${id}`]?.available, true);
  }
  assert.equal(
    childSessionIsLive(
      state.childSessions['parent-a']!['child-e']!,
      state.childRuntime['parent-a']?.['child-e'],
    ),
    false,
  );

  state = dispatchEvent(state, {
    type: 'child.updated',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-e',
    requestId: 'request-e',
    access: 'ready',
    runtimeGeneration: 2,
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-e'], {
    state: 'ready',
    requestId: 'request-e',
    runtimeGeneration: 2,
  });
  assert.equal(state.childRuntime['parent-a']?.['child-e']?.available, true);
  const admitted = visibleSessionTarget(
    'parent-a',
    { parentAppSessionId: 'parent-a', childSessionId: 'child-e' },
    state.childSessions,
    state.childAccess,
  );
  assert.equal(admitted.kind, 'child');
  if (admitted.kind === 'child') assert.equal(admitted.canSend, true);
});

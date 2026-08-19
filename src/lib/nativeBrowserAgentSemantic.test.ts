import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BrowserNativeRequest,
  BrowserNativeResult,
  BrowserNativeSnapshot,
} from '../types/bridge';
import {
  getNativeBrowserSemanticObservation,
  getNativeBrowserSemanticState,
  performNativeBrowserRequest,
  performNativeBrowserRequestWithSemanticState,
  registerNativeBrowserController,
  resetNativeBrowserSemanticState,
} from './nativeBrowserAgent';

function request(action: BrowserNativeRequest['action'], requestId: string): BrowserNativeRequest {
  return {
    requestId,
    appSessionId: 'session-1',
    browserSessionId: 'browser-1',
    action,
  };
}

function snapshot(label: string): BrowserNativeSnapshot {
  return {
    url: 'https://example.test',
    scroll: { x: 0, y: 0 },
    refs: [
      {
        ref: '@button',
        selector: '#button',
        tagName: 'button',
        role: 'button',
        name: label,
        box: { x: 10, y: 10, width: 100, height: 32 },
      },
    ],
  };
}

function success(
  input: BrowserNativeRequest,
  browserSnapshot?: BrowserNativeSnapshot,
): BrowserNativeResult {
  return {
    requestId: input.requestId,
    appSessionId: input.appSessionId,
    browserSessionId: input.browserSessionId,
    ok: true,
    snapshot: browserSnapshot,
  };
}

test(
  'ordinary native browser requests populate semantic state without changing their result',
  async () => {
    resetNativeBrowserSemanticState();
    const dispose = registerNativeBrowserController({
      perform: async (input) => success(input, snapshot('Save')),
    });

    const result = await performNativeBrowserRequest(request('snapshot', 'req-1'));
    dispose();

    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.refs[0]?.name, 'Save');
    assert.equal(getNativeBrowserSemanticState('browser-1')?.revision, 1);
    assert.equal(
      getNativeBrowserSemanticState('browser-1')?.entities[0]?.kind,
      'button',
    );
  },
);

test('semantic request wrapper returns only changes since the caller revision', async () => {
  resetNativeBrowserSemanticState();
  let label = 'Save';
  const dispose = registerNativeBrowserController({
    perform: async (input) => success(input, snapshot(label)),
  });

  const first = await performNativeBrowserRequestWithSemanticState(
    request('snapshot', 'req-1'),
  );
  label = 'Save changes';
  const second = await performNativeBrowserRequestWithSemanticState(
    request('snapshot', 'req-2'),
    { sinceRevision: first.observation?.state.revision },
  );
  dispose();

  assert.equal(first.observation?.state.revision, 1);
  assert.equal(first.observation?.delta.reset, true);
  assert.equal(second.observation?.state.revision, 2);
  assert.equal(second.observation?.delta.fromRevision, 1);
  assert.deepEqual(
    second.observation?.delta.entities.updated.map((entity) => entity.id),
    ['@button'],
  );
});

test('closing a browser session clears its semantic history', async () => {
  resetNativeBrowserSemanticState();
  const dispose = registerNativeBrowserController({
    perform: async (input) => {
      if (input.action === 'close') return success(input);
      return success(input, snapshot('Save'));
    },
  });

  await performNativeBrowserRequest(request('snapshot', 'req-1'));
  assert.equal(getNativeBrowserSemanticObservation('browser-1')?.state.revision, 1);

  await performNativeBrowserRequest(request('close', 'req-2'));
  assert.equal(getNativeBrowserSemanticState('browser-1'), undefined);

  const reopened = await performNativeBrowserRequestWithSemanticState(
    request('snapshot', 'req-3'),
  );
  dispose();

  assert.equal(reopened.observation?.state.revision, 1);
  assert.equal(reopened.observation?.delta.reset, true);
});

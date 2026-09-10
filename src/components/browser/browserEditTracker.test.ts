import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from '../../hooks/useStore';
import type { TranscriptEvent } from '../../types/bridge';
import { createBrowserEditTracker } from './browserEditTracker';

function event(
  kind: TranscriptEvent['kind'],
  toolUseId: string,
  overrides: Partial<TranscriptEvent> = {},
): TranscriptEvent {
  return {
    id: `${kind}-${toolUseId}`,
    appSessionId: 'chat',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 100,
    kind,
    toolUseId,
    toolName: kind === 'tool_call' ? 'Edit' : undefined,
    ...overrides,
  };
}

function tracker() {
  let state = initialState;
  const observe = createBrowserEditTracker();
  observe([], undefined);
  return {
    append(...events: TranscriptEvent[]) {
      state = reducer(state, {
        type: 'BATCH',
        actions: events.map((event) => ({ type: 'SESSION_TRANSCRIPT', event })),
      });
    },
    observe() {
      return observe(state.transcripts.chat, state.transcriptMutations.chat);
    },
  };
}

test('concurrent edits survive unrelated and out-of-order results with equal timestamps', () => {
  const edits = tracker();
  edits.append(event('tool_call', 'a'), event('tool_call', 'b'));
  assert.equal(edits.observe(), false);
  edits.append(event('tool_result', 'unrelated'));
  assert.equal(edits.observe(), false);
  edits.append(event('tool_result', 'b'));
  assert.equal(edits.observe(), true);
  edits.append(event('tool_result', 'a'));
  assert.equal(edits.observe(), true);
  assert.equal(edits.observe(), false);
});

test('one transcript batch and skipped renders retain edit call/result pairs', () => {
  const edits = tracker();
  edits.append(event('tool_call', 'batched'), event('tool_result', 'batched'));
  assert.equal(edits.observe(), true);
  edits.append(event('tool_call', 'skipped'));
  edits.append(event('tool_result', 'skipped'), event('text', 'trailing'));
  assert.equal(edits.observe(), true);
});

test('failed and sibling results do not consume a different source edit', () => {
  const edits = tracker();
  edits.append(event('tool_call', 'a'), event('tool_call', 'b'));
  edits.observe();
  edits.append(event('tool_result', 'a', { sourceSessionId: 'child', id: 'child-result' }));
  assert.equal(edits.observe(), false);
  edits.append(event('tool_result', 'b', { isError: true }));
  assert.equal(edits.observe(), false);
  edits.append(event('tool_result', 'a'));
  assert.equal(edits.observe(), true);
});

test('history replacement establishes a baseline without replaying old edits', () => {
  const observe = createBrowserEditTracker();
  const history = [event('tool_call', 'old'), event('tool_result', 'old')];
  assert.equal(
    observe(history, {
      kind: 'reset',
      revision: 1,
      baseRevision: 0,
      previousLength: 0,
      firstChangedIndex: 0,
    }),
    false,
  );
  assert.equal(
    observe([...history, event('text', 'new')], {
      kind: 'append',
      revision: 2,
      baseRevision: 1,
      previousLength: 2,
      firstChangedIndex: 2,
    }),
    false,
  );
});

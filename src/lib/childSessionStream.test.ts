import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChildSessionSummary } from '../types/bridge';
import type { ChildSessionActivity } from './childSessions';
import {
  boundChildStreamPreview,
  CHILD_STREAM_PHASE_LABEL,
  CHILD_STREAM_PREVIEW_MAX_CHARS,
  CHILD_STREAM_PREVIEW_MAX_LINES,
  childStreamPhase,
  childStreamSnapshot,
  projectChildStreamSnapshots,
  reuseChildStreamSnapshotMap,
  sameChildStreamSnapshot,
} from './childSessionStream';

function child(
  overrides: Partial<ChildSessionSummary> &
    Pick<ChildSessionSummary, 'childSessionId' | 'status'> = {
    childSessionId: 'child-a',
    status: 'running',
  },
): ChildSessionSummary {
  return {
    parentAppSessionId: 'parent',
    role: 'worker',
    modelId: 'droid-core',
    transcriptAvailable: true,
    spawnLink: { kind: 'tool-use', id: `tool-${overrides.childSessionId}` },
    startedAt: 1_000,
    ...overrides,
  };
}

function activity(latest: ChildSessionActivity['latest']): ChildSessionActivity {
  return { status: 'running', startedAt: 1_000, latest };
}

test('boundChildStreamPreview keeps a fixed tail of lines and characters', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)} ${'x'.repeat(80)}`);
  const preview = boundChildStreamPreview(lines.join('\n'));
  assert.equal(preview.split('\n').length <= CHILD_STREAM_PREVIEW_MAX_LINES, true);
  assert.ok(preview.length <= CHILD_STREAM_PREVIEW_MAX_CHARS);
  assert.ok(preview.includes('line 39'));
  assert.equal(preview.includes('line 0'), false);
});

test('growing a long answer does not grow the bounded preview', () => {
  let text = 'alpha\nbeta\ngamma';
  const first = boundChildStreamPreview(text);
  text += `${' more'.repeat(400)}\n${'z'.repeat(500)} omega`;
  const next = boundChildStreamPreview(text);
  assert.equal(next.split('\n').length, CHILD_STREAM_PREVIEW_MAX_LINES);
  assert.equal(first.split('\n').length, CHILD_STREAM_PREVIEW_MAX_LINES);
  assert.ok(next.length <= CHILD_STREAM_PREVIEW_MAX_CHARS);
  assert.ok(next.includes('omega'));
});

test('childStreamPhase maps each supervision state distinctly', () => {
  assert.equal(childStreamPhase({ queued: true, status: 'pending' }), 'queued');
  assert.equal(childStreamPhase({ status: 'pending' }), 'starting');
  assert.equal(childStreamPhase({ status: 'running' }), 'starting');
  assert.equal(childStreamPhase({ status: 'running', hasOutput: true }), 'streaming');
  assert.equal(childStreamPhase({ status: 'paused' }), 'awaiting_approval');
  assert.equal(childStreamPhase({ status: 'completed' }), 'settled');
  assert.equal(childStreamPhase({ status: 'completed', isError: true }), 'failed');
  assert.equal(
    childStreamPhase({ status: 'paused', interruptReason: 'could not reconnect' }),
    'interrupted',
  );
  assert.equal(
    childStreamPhase({ status: 'completed', interruptReason: 'could not reconnect' }),
    'interrupted',
  );
});

test('childStreamSnapshot prefers live transcript text and stays bounded', () => {
  const snapshot = childStreamSnapshot(
    child({ childSessionId: 'writer', status: 'running' }),
    activity({
      kind: 'text',
      text: `${'paragraph\n'.repeat(20)}${'a'.repeat(400)} final token burst`,
    }),
  );
  assert.equal(snapshot.phase, 'streaming');
  assert.equal(snapshot.previewKind, 'markdown');
  assert.equal(snapshot.live, true);
  assert.ok(snapshot.preview.length <= CHILD_STREAM_PREVIEW_MAX_CHARS);
  assert.ok(snapshot.preview.includes('final token burst'));
});

test('projectChildStreamSnapshots reuses unchanged sibling identities', () => {
  const children = [
    child({ childSessionId: 'a', status: 'running' }),
    child({ childSessionId: 'b', status: 'running' }),
    child({ childSessionId: 'c', status: 'running' }),
    child({ childSessionId: 'd', status: 'pending', queued: true }),
  ];
  const activityFor =
    (text: Partial<Record<string, string>>) =>
    (session: ChildSessionSummary): ChildSessionActivity => ({
      status: session.status,
      startedAt: session.startedAt,
      latest: text[session.childSessionId]
        ? { kind: 'text', text: text[session.childSessionId] }
        : undefined,
    });

  const first = projectChildStreamSnapshots(children, activityFor({ a: 'one', b: 'two' }));
  const second = projectChildStreamSnapshots(
    children,
    activityFor({ a: 'one more', b: 'two' }),
    undefined,
    first,
  );

  assert.equal(second.get('tool-a') === first.get('tool-a'), false);
  assert.equal(second.get('tool-b'), first.get('tool-b'));
  assert.equal(second.get('tool-c'), first.get('tool-c'));
  assert.equal(second.get('tool-d'), first.get('tool-d'));
  assert.equal(sameChildStreamSnapshot(first.get('tool-b'), second.get('tool-b')!), true);
  assert.equal(reuseChildStreamSnapshotMap(first, first), first);
});

test('four concurrent streaming children do not rewrite settled snapshots', () => {
  const children = ['w1', 'w2', 'w3', 'w4'].map((id) =>
    child({ childSessionId: id, status: 'running' }),
  );
  let previous = projectChildStreamSnapshots(children, () =>
    activity({ kind: 'text', text: 'start' }),
  );
  for (let token = 1; token <= 50; token += 1) {
    const next = projectChildStreamSnapshots(
      children,
      (session) =>
        activity({
          kind: 'text',
          text: session.childSessionId === 'w2' ? `token ${String(token)}` : 'start',
        }),
      undefined,
      previous,
    );
    assert.equal(next.get('tool-w1'), previous.get('tool-w1'));
    assert.equal(next.get('tool-w3'), previous.get('tool-w3'));
    assert.equal(next.get('tool-w4'), previous.get('tool-w4'));
    assert.notEqual(next.get('tool-w2'), previous.get('tool-w2'));
    previous = next;
  }
});

test('phase labels stay the product words, not a parallel status vocabulary', () => {
  assert.equal(CHILD_STREAM_PHASE_LABEL.queued, 'Queued');
  assert.equal(CHILD_STREAM_PHASE_LABEL.interrupted, 'Interrupted');
  assert.equal(CHILD_STREAM_PHASE_LABEL.awaiting_approval, 'Awaiting approval');
});

test('interruptReason on a paused child is interrupted, not a fabricated progress state', () => {
  const snapshot = childStreamSnapshot(
    child({ childSessionId: 'paused', status: 'paused' }),
    { status: 'paused', startedAt: 1_000 },
    'Turn interrupted because the runtime could not reconnect.',
  );
  assert.equal(snapshot.phase, 'interrupted');
  assert.equal(snapshot.live, false);
});

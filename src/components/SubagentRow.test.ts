import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChildSessionSummary } from '../types/bridge';
import type { ChildStreamSnapshot } from '../lib/childSessionStream';
import {
  CHILD_STREAM_PHASE_LABEL,
  CHILD_STREAM_PREVIEW_BOX_CLASS,
  CHILD_STREAM_PREVIEW_EXPANDED_BOX_CLASS,
  childStreamPhaseLabel,
  childStreamPreviewBoxClass,
} from '../lib/childSessionStream';
import {
  areSubagentRowPropsEqual,
  SubagentRow,
  subagentRowTitle,
  type SubagentRowProps,
} from './SubagentRow';

function snapshot(
  phase: ChildStreamSnapshot['phase'],
  preview = 'hello',
  fidelity: ChildStreamSnapshot['fidelity'] = 'token',
): ChildStreamSnapshot {
  return {
    key: 'tool-a',
    phase,
    fidelity,
    step:
      phase === 'streaming' && fidelity !== 'token' ? 'Working' : CHILD_STREAM_PHASE_LABEL[phase],
    preview,
    previewKind: phase === 'streaming' && fidelity === 'token' ? 'markdown' : 'plain',
    live: phase === 'streaming' || phase === 'starting',
  };
}

function child(): ChildSessionSummary {
  return {
    parentAppSessionId: 'parent',
    childSessionId: 'child-a',
    role: 'worker',
    status: 'running',
    modelId: 'droid-core',
    transcriptAvailable: true,
    spawnLink: { kind: 'tool-use', id: 'tool-a' },
    startedAt: 1_000,
    streamFidelity: 'token',
  };
}

function props(overrides: Partial<SubagentRowProps> = {}): SubagentRowProps {
  return {
    child: child(),
    name: 'Worker 1',
    snapshot: snapshot('streaming'),
    ...overrides,
  };
}

test('sibling rows skip re-render when only another child snapshot changes', () => {
  const rowChild = child();
  const stable = snapshot('streaming', 'unchanged');
  const previous = props({ child: rowChild, snapshot: stable });
  const next = props({ child: rowChild, snapshot: stable });
  assert.equal(areSubagentRowPropsEqual(previous, next), true);
  assert.equal(
    areSubagentRowPropsEqual(
      previous,
      props({ child: rowChild, snapshot: snapshot('streaming', 'changed') }),
    ),
    false,
  );
});

test('each child stream phase renders a distinct label', () => {
  for (const phase of Object.keys(CHILD_STREAM_PHASE_LABEL) as ChildStreamSnapshot['phase'][]) {
    const html = renderToStaticMarkup(
      createElement(SubagentRow, props({ snapshot: snapshot(phase, `${phase} body`) })),
    );
    assert.ok(html.includes(`data-phase="${phase}"`));
    assert.ok(html.includes(childStreamPhaseLabel(phase, 'token')));
  }
});

test('token fidelity shows a caret; state and tool never do', () => {
  const token = renderToStaticMarkup(
    createElement(SubagentRow, props({ snapshot: snapshot('streaming', 'delta', 'token') })),
  );
  const state = renderToStaticMarkup(
    createElement(SubagentRow, props({ snapshot: snapshot('streaming', 'poll lump', 'state') })),
  );
  const tool = renderToStaticMarkup(
    createElement(SubagentRow, props({ snapshot: snapshot('streaming', 'ApplyPatch', 'tool') })),
  );
  assert.ok(token.includes('data-testid="subagent-stream-caret"'));
  assert.ok(token.includes('caret-blink'));
  assert.ok(token.includes('data-presentation="typewriter"'));
  assert.equal(state.includes('caret-blink'), false);
  assert.equal(state.includes('data-testid="subagent-stream-caret"'), false);
  assert.ok(state.includes('data-presentation="working"'));
  assert.ok(state.includes('data-testid="subagent-working-cue"'));
  assert.ok(state.includes('Working'));
  assert.equal(tool.includes('caret-blink'), false);
  assert.ok(tool.includes('data-presentation="tool"'));
});

test('the live preview box keeps a fixed height class while tokens update', () => {
  assert.equal(childStreamPreviewBoxClass(false), CHILD_STREAM_PREVIEW_BOX_CLASS);
  assert.equal(childStreamPreviewBoxClass(true), CHILD_STREAM_PREVIEW_EXPANDED_BOX_CLASS);
  const first = renderToStaticMarkup(
    createElement(SubagentRow, props({ snapshot: snapshot('streaming', 'alpha') })),
  );
  const second = renderToStaticMarkup(
    createElement(SubagentRow, props({ snapshot: snapshot('streaming', 'alpha beta gamma') })),
  );
  assert.ok(first.includes(CHILD_STREAM_PREVIEW_BOX_CLASS));
  assert.ok(second.includes(CHILD_STREAM_PREVIEW_BOX_CLASS));
  assert.equal(first.includes(CHILD_STREAM_PREVIEW_EXPANDED_BOX_CLASS), false);
  assert.equal(second.includes(CHILD_STREAM_PREVIEW_EXPANDED_BOX_CLASS), false);
});

test('opening a child transcript is a separate control from expanding the preview', () => {
  const html = renderToStaticMarkup(
    createElement(SubagentRow, {
      ...props(),
      target: { toolUseId: 'tool-a' },
      onOpen: () => undefined,
    }),
  );
  assert.ok(html.includes('Show more'));
  assert.ok(html.includes('Open transcript'));
  assert.equal(
    subagentRowTitle('Worker 1', { childSessionId: 'child-a' }),
    'Open Worker 1 session\nChild ID: child-a',
  );
});

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
} from '../lib/childSessionStream';
import {
  areSubagentRowPropsEqual,
  SubagentRow,
  subagentRowTitle,
  type SubagentRowProps,
} from './SubagentRow';
import { childStreamPreviewBoxClass } from './SubagentStreamPreview';

function snapshot(phase: ChildStreamSnapshot['phase'], preview = 'hello'): ChildStreamSnapshot {
  return {
    key: 'tool-a',
    phase,
    preview,
    previewKind: phase === 'streaming' ? 'markdown' : 'plain',
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
    assert.ok(html.includes(CHILD_STREAM_PHASE_LABEL[phase]));
  }
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

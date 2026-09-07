import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubagentPanelRow, SubagentsSection } from './SubagentsPanel';
import type { ChildSessionSummary, ChildStatus } from '../types/bridge';

let seq = 0;
function child(
  status: ChildStatus,
  overrides: Partial<ChildSessionSummary> = {},
): ChildSessionSummary {
  seq += 1;
  return {
    parentAppSessionId: 'p',
    childSessionId: `child-${seq}`,
    role: 'worker',
    status,
    label: `agent-${seq}`,
    modelId: 'droid-core',
    transcriptAvailable: true,
    startedAt: seq,
    streamFidelity: 'state',
    ...overrides,
  };
}

function renderSection(
  childSessions: ChildSessionSummary[],
  extra: Partial<Parameters<typeof SubagentsSection>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(SubagentsSection, {
      childSessions,
      models: [],
      selectedChildSessionId: null,
      onSelect: () => undefined,
      ...extra,
    }),
  );
}

function renderRow(
  info: ChildSessionSummary,
  extra: Partial<Parameters<typeof SubagentPanelRow>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(SubagentPanelRow, {
      child: info,
      label: info.label ?? info.childSessionId,
      seed: info.childSessionId,
      models: [],
      selected: false,
      onSelect: () => undefined,
      ...extra,
    }),
  );
}

// Adjacent text expressions render with comment separators; strip them so text
// assertions match what a user reads.
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '');

test('the summary line rolls up live counts next to the avatar stack', () => {
  const text = textOf(
    renderSection([child('running'), child('running'), child('pending'), child('completed')]),
  );
  assert.ok(text.includes('Subagents'));
  // Running agents count as working; pending ones are not claimed yet.
  assert.ok(text.includes('2 working'));
  assert.ok(text.includes('1 done'));
  // The working readout shimmers instead of spinning or pulsing.
  const html = renderSection([child('running')]);
  assert.match(html, /shimmer-text[^"]*">1 working/);
});

test('the rollup falls back to a plain agent count', () => {
  const text = textOf(renderSection([child('pending'), child('paused')]));
  assert.ok(!text.includes('working'));
  assert.ok(!text.includes('done'));
  assert.ok(text.includes('2 agents'));
});

test('the avatar stack caps at four and counts the overflow', () => {
  const four = textOf(renderSection(Array.from({ length: 4 }, () => child('running'))));
  assert.ok(!four.includes('+'));
  const seven = textOf(renderSection(Array.from({ length: 7 }, () => child('running'))));
  assert.ok(seven.includes('+3'));
});

test('rows stay out of the panel markup — the list lives in the popover', () => {
  // The popover is portaled and only positions client-side, so a static
  // render shows only the stable summary line no matter how many agents run.
  const html = renderSection([child('running'), child('running'), child('running')]);
  assert.match(html, /data-testid="subagents-summary"/);
  assert.doesNotMatch(html, /data-testid="subagent-row"/);
  assert.match(html, /aria-haspopup="dialog"/);
});

test('rows render the label and a quiet status readout', () => {
  assert.ok(textOf(renderRow(child('running', { label: 'explorer' }))).includes('explorer'));
  assert.match(renderRow(child('running')), /shimmer-text[^"]*">Working/);
  assert.ok(textOf(renderRow(child('pending'))).includes('Awaiting status'));
  assert.ok(textOf(renderRow(child('paused'))).includes('Idle'));
  assert.ok(textOf(renderRow(child('completed'))).includes('Done'));
});

test('rows show the exact launch model and effort', () => {
  const html = renderRow(
    child('running', {
      childSessionId: 'child-stable-id',
      modelId: 'custom:glm-5.2',
      reasoningEffort: 'max',
    }),
    {
      models: [{ id: 'custom:glm-5.2', displayName: 'GLM 5.2', isCustom: true }],
    },
  );
  assert.ok(textOf(html).includes('GLM 5.2 (custom:glm-5.2) · max'));
  assert.ok(html.includes('Child ID: child-stable-id'));
});

test('a spawn the store has not registered yet renders but cannot be opened', () => {
  const html = renderRow(child('running', { childSessionId: 'pending-tool-a', label: 'explorer' }));
  assert.ok(textOf(html).includes('explorer'));
  assert.match(html, /<button[^>]*disabled/);
});

test('the selected row is highlighted', () => {
  const target = child('running');
  const html = renderRow(target, { selected: true });
  assert.match(
    html,
    new RegExp(`data-child-session-id="${target.childSessionId}" class="[^"]*bg-droid-elevated`),
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanStepsPanel } from './PlanSteps';
import type { TodoItem } from '../../lib/tools';

const render = (steps: TodoItem[], isRunning = true) =>
  renderToStaticMarkup(createElement(PlanStepsPanel, { steps, isRunning, resetKey: 's' }));

test('renders nothing without a plan', () => {
  assert.equal(render([]), '');
});

test('the collapsed header keeps the current step visible with the spinning ring', () => {
  const steps: TodoItem[] = [
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'completed', text: 'Start a new app' },
    { status: 'in_progress', text: 'Implement the tracker' },
    { status: 'pending', text: 'Ship it' },
  ];
  const html = render(steps, true);
  assert.match(html, /aria-expanded="false"/);
  // The collapsed row is the third step, spinning — not a generic counter.
  const header = /<button[^>]*aria-expanded="false"[^>]*>.*?<\/button>/s.exec(html)?.[0];
  assert.match(header ?? '', /Implement the tracker/);
  assert.match(header ?? '', /animate-spin/);
  assert.doesNotMatch(html, /\d+\/\d+/);
  // The expanded list omits the current step instead of repeating the summary.
  assert.equal(html.match(/Implement the tracker/g)?.length, 1);
});

test('the header ring only spins while the session is generating', () => {
  const steps: TodoItem[] = [{ status: 'in_progress', text: 'Start a new app' }];
  assert.match(render(steps, true), /animate-spin/);
  assert.doesNotMatch(render(steps, false), /animate-spin/);
});

test('finished plan fills every ring and drops the active band', () => {
  const html = render(
    [
      { status: 'completed', text: 'Investigate the APIs' },
      { status: 'completed', text: 'Start a new app' },
    ],
    false,
  );
  assert.doesNotMatch(html, /animate-spin/);
  // The current step lives in the summary, while the other completed step stays in the list.
  assert.equal(html.match(/lucide-check/g)?.length, 2);
  assert.doesNotMatch(html, /bg-droid-active\/50/);
  // The header falls back to the last step once nothing is running.
  assert.match(html, /Start a new app/);
});

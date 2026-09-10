import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutomationRow } from './AutomationRow';
import { defaultAutomationDraft } from './schedule';
import type { Automation } from './types';

function renderStatus(status: Automation['lastRunStatus']): string {
  const automation: Automation = {
    ...defaultAutomationDraft(null, 'model-a', 'high'),
    id: 'automation-a',
    title: 'Review changes',
    timezone: 'UTC',
    nextRunAt: null,
    lastRunAt: status === null ? null : 1_000,
    lastRunStatus: status,
    lastRunError: null,
    lastRunDurationMs: null,
    lastAppSessionId: null,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  return renderToStaticMarkup(
    createElement(AutomationRow, {
      automation,
      run: undefined,
      model: undefined,
      modelIssue: null,
      now: 2_000,
      deleteArmed: false,
      last: true,
      onEdit: () => undefined,
      onToggle: () => undefined,
      onRun: () => undefined,
      onOpenSession: () => undefined,
      onDelete: () => undefined,
    }),
  );
}

test('automation clocks stay static and active runs use the motion-safe spinner', () => {
  for (const status of [null, 'queued'] as const) {
    const html = renderStatus(status);
    assert.equal(html.match(/data-icon="clock"/g)?.length, 2);
    assert.doesNotMatch(html, /animate-spin/);
  }

  for (const status of ['starting', 'running'] as const) {
    const html = renderStatus(status);
    const spinners = html.match(/<svg[^>]*data-icon="spinner"[^>]*>/g) ?? [];
    assert.equal(spinners.length, 2);
    assert.ok(spinners.some((icon) => icon.includes('h-4 w-4')));
    assert.ok(spinners.some((icon) => icon.includes('h-3 w-3')));
    for (const icon of spinners) {
      assert.match(icon, /motion-safe:animate-spin-slow/);
      assert.match(icon, /stroke-width="2"/);
      assert.match(icon, /text-droid-text-secondary/);
    }
  }
});

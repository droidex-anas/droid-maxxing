import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarSessionList, type SidebarSessionListProps } from './SidebarSessionList.js';
import { SIDEBAR_VISIBLE_SESSION_LIMIT } from '../lib/workspaces.js';
import type { SessionSummary } from '../types/bridge.js';

function session(appSessionId: string, updatedAt: number): SessionSummary {
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/repo/app',
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

function render(overrides: Partial<SidebarSessionListProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SidebarSessionList, {
      sessions: [],
      visibleCount: SIDEBAR_VISIBLE_SESSION_LIMIT,
      activeAppSessionId: null,
      renderRow: (item) => createElement('div', { key: item.appSessionId }, item.appSessionId),
      onShowMore: () => undefined,
      onShowLess: () => undefined,
      ...overrides,
    }),
  );
}

const eight = Array.from({ length: 8 }, (_, index) => session(`s-${String(index)}`, index));

test('the list pages to the visible count and offers to show more', () => {
  const html = render({ sessions: eight });

  assert.ok(html.includes('s-4'));
  assert.ok(!html.includes('s-5'));
  assert.ok(html.includes('Show more'));
  assert.ok(!html.includes('Show less'));
});

test('an expanded list can be collapsed again', () => {
  const html = render({ sessions: eight, visibleCount: 10 });

  assert.ok(html.includes('s-7'));
  assert.ok(!html.includes('Show more'));
  assert.ok(html.includes('Show less'));
});

test('the active session stays visible below the paged window', () => {
  const html = render({ sessions: eight, activeAppSessionId: 's-7' });

  assert.ok(html.includes('s-7'));
  assert.ok(!html.includes('s-6'));
});

test('earlier pre-existing sessions are offered once everything loaded is shown', () => {
  const html = render({
    sessions: eight.slice(0, 3),
    earlierSessionCount: 943,
    onShowEarlier: () => undefined,
  });

  assert.ok(html.includes('Show 943 earlier'));
});

test('earlier sessions wait until the loaded list has been paged through', () => {
  const html = render({
    sessions: eight,
    earlierSessionCount: 943,
    onShowEarlier: () => undefined,
  });

  assert.ok(html.includes('Show more'));
  assert.ok(!html.includes('Show 943 earlier'));
});

test('a folder with nothing withheld shows no reveal control', () => {
  const html = render({
    sessions: eight.slice(0, 3),
    earlierSessionCount: 0,
    onShowEarlier: () => undefined,
  });

  assert.ok(!html.includes('earlier'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarSessionList, type SidebarSessionListProps } from './SidebarSessionList.js';
import { SIDEBAR_VISIBLE_SESSION_LIMIT } from '../lib/workspaces.js';
import type { SessionSummary } from '../types/bridge.js';
import { droidSessionConfiguration } from '../lib/sessionConfiguration';

function session(appSessionId: string, updatedAt: number): SessionSummary {
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/repo/app',
    workspaceKind: 'folder',
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

// The repo has no DOM test host, so a control's behavior is exercised by
// finding its element in the rendered tree and calling the handler it wired.
function clickControl(props: Partial<SidebarSessionListProps>, label: string): void {
  const tree = SidebarSessionList({
    sessions: [],
    visibleCount: SIDEBAR_VISIBLE_SESSION_LIMIT,
    activeAppSessionId: null,
    renderRow: (item) => createElement('div', { key: item.appSessionId }, item.appSessionId),
    onShowMore: () => undefined,
    onShowLess: () => undefined,
    ...props,
  });
  const button = findButton(tree, label);
  assert.ok(button, `no control labelled ${label}`);
  const onClick = (button.props as { onClick?: () => void }).onClick;
  assert.ok(onClick, `control ${label} has no click handler`);
  onClick();
}

function findButton(node: ReactNode, label: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { children?: ReactNode };
  if (node.type === 'button' && flatten(props.children).includes(label)) return node;
  return findButton(props.children, label);
}

function flatten(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement(node)) return '';
  return flatten((node.props as { children?: ReactNode }).children);
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

test('revealing earlier sessions also pages them into view', () => {
  let revealed = 0;
  let paged = 0;

  clickControl(
    {
      sessions: eight.slice(0, 3),
      earlierSessionCount: 943,
      onShowEarlier: () => {
        revealed += 1;
      },
      onShowMore: () => {
        paged += 1;
      },
    },
    'Show 943 earlier',
  );

  assert.equal(revealed, 1);
  assert.equal(paged, 1);
});

test('a folder with nothing withheld shows no reveal control', () => {
  const html = render({
    sessions: eight.slice(0, 3),
    earlierSessionCount: 0,
    onShowEarlier: () => undefined,
  });

  assert.ok(!html.includes('earlier'));
});

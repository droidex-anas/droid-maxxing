import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarWorkspaceRow, WorkspaceContextMenuPanel } from './SidebarWorkspaceRow';

test('a workspace row keeps Remove off the heading until a context menu opens', () => {
  const html = renderToStaticMarkup(
    createElement(
      SidebarWorkspaceRow,
      {
        name: 'droid-control',
        open: true,
        onToggle: () => undefined,
        onNewChat: () => undefined,
        onRemove: () => undefined,
      },
      null,
    ),
  );
  assert.match(html, /droid-control/);
  assert.match(html, /New chat here/);
  assert.doesNotMatch(html, /Remove workspace/);
});

test('the workspace menu offers Remove workspace', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceContextMenuPanel, {
      x: 40,
      y: 40,
      name: 'droid-control',
      onRemove: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(html, /Remove workspace/);
  assert.match(html, /role="menu"/);
});

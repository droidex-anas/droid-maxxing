import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionContextMenuPanel, type SessionContextMenuProps } from './SessionContextMenu';

// The panel clamps to the viewport during render, so the SSR test needs a
// minimal window global. (The portal wrapper stays untestable in SSR —
// portals reject fake document.body containers — hence rendering the panel.)
const g = globalThis as { window?: unknown };
g.window ??= {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

function render(props: Partial<SessionContextMenuProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionContextMenuPanel, {
      x: 40,
      y: 40,
      pinned: false,
      cwd: '/repo',
      providerSessionId: 'droid-123',
      onRename: () => undefined,
      onTogglePin: () => undefined,
      onArchive: () => undefined,
      onCopyMarkdown: () => undefined,
      onClose: () => undefined,
      ...props,
    }),
  );
}

test('SessionContextMenu lists organization actions first, then the copy actions', () => {
  const html = render();
  const order = [
    'Pin chat',
    'Rename chat',
    'Archive chat',
    'Copy Working Directory',
    'Copy Session ID',
    'Copy Session Link',
    'Copy as Markdown',
  ];
  const positions = order.map((label) => html.indexOf(label));
  for (const [index, position] of positions.entries()) {
    assert.notEqual(position, -1, `${order[index]} should render`);
    if (index > 0) assert.ok(position > positions[index - 1], `${order[index]} out of order`);
  }
  assert.match(html, /aria-label="Chat actions"/);
});

test('SessionContextMenu swaps the pin label for a pinned chat', () => {
  assert.match(render({ pinned: true }), /Unpin chat/);
});

test('SessionContextMenu hides the working-directory row when the session has none', () => {
  const html = render({ cwd: undefined });
  assert.doesNotMatch(html, /Copy Working Directory/);
  assert.match(html, /Copy Session ID/);
});

test('SessionContextMenu hides the working-directory row for an empty cwd too', () => {
  const html = render({ cwd: '' });
  assert.doesNotMatch(html, /Copy Working Directory/);
});

test('SessionContextMenu clamps to the viewport bottom using the rendered row count', () => {
  // Full menu (cwd + provider id => 7 rows): 18 chrome + 7*30 = 228px tall.
  const html = render({ y: 790 });
  const top = /top:\s*([\d.]+)px/.exec(html);
  assert.ok(top, 'expected an inline top style');
  // 800 - 228 - 8 margin = 564.
  assert.equal(Number(top[1]), 564);
});

test('SessionContextMenu separator is exposed to assistive technology', () => {
  assert.match(render(), /role="separator"/);
});

test('SessionContextMenu hides the session id and link rows until the harness assigns an id', () => {
  const html = render({ providerSessionId: undefined });
  assert.doesNotMatch(html, /Copy Session ID/);
  assert.doesNotMatch(html, /Copy Session Link/);
  assert.match(html, /Copy Working Directory/);
  assert.match(html, /Copy as Markdown/);
});

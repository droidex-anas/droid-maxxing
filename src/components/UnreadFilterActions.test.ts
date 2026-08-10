import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnreadFilterActions } from './UnreadFilterActions';

// Ported from the deleted Sidebar.test.ts during the SessionRow extraction:
// upstream added this coverage while the branch rehomed the row tests.
test('unread actions expose Mark all as read only inside a non-empty unread view', () => {
  const hidden = renderToStaticMarkup(
    createElement(UnreadFilterActions, {
      unreadOnly: false,
      unreadCount: 12,
      onToggleUnread: () => undefined,
      onMarkAllRead: () => undefined,
    }),
  );
  assert.match(hidden, /aria-label="Show unread only"/);
  assert.match(hidden, />9\+</);
  assert.doesNotMatch(hidden, /Mark all as read/);

  const visible = renderToStaticMarkup(
    createElement(UnreadFilterActions, {
      unreadOnly: true,
      unreadCount: 2,
      onToggleUnread: () => undefined,
      onMarkAllRead: () => undefined,
    }),
  );
  assert.match(visible, /aria-label="Show all sessions"/);
  assert.match(visible, /Mark all as read/);

  const empty = renderToStaticMarkup(
    createElement(UnreadFilterActions, {
      unreadOnly: true,
      unreadCount: 0,
      onToggleUnread: () => undefined,
      onMarkAllRead: () => undefined,
    }),
  );
  assert.doesNotMatch(empty, /Mark all as read/);
});

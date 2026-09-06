import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SidebarSearchNotice from './SidebarSearchNotice';
import {
  HISTORY_INDEXING_INCOMPLETE_MESSAGE,
  HISTORY_SEARCH_UNAVAILABLE_MESSAGE,
} from '../lib/historyStatusCopy';

test('unavailable search renders an explanation instead of a bare empty state', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarSearchNotice, { kind: 'unavailable', layout: 'empty' }),
  );
  assert.ok(html.includes('data-testid="sidebar-search-unavailable"'));
  assert.ok(html.includes(HISTORY_SEARCH_UNAVAILABLE_MESSAGE));
  assert.doesNotMatch(html, /No sessions found/);
  assert.doesNotMatch(html, /\d+\s*%/);
  assert.doesNotMatch(html, /ETA/i);
});

test('incomplete indexing is labelled beside results without fabricating progress', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarSearchNotice, { kind: 'indexing', layout: 'inline' }),
  );
  assert.ok(html.includes('data-testid="sidebar-search-indexing"'));
  assert.ok(html.includes(HISTORY_INDEXING_INCOMPLETE_MESSAGE));
  assert.doesNotMatch(html, /\d+\s*%/);
  assert.doesNotMatch(html, /ETA/i);
  assert.doesNotMatch(html, /progress/i);
});

test('a complete empty search stays the plain empty copy', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarSearchNotice, { kind: 'empty', layout: 'empty' }),
  );
  assert.match(html, /No sessions found/);
  assert.doesNotMatch(html, /data-testid="sidebar-search-unavailable"/);
  assert.doesNotMatch(html, /data-testid="sidebar-search-indexing"/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConversationVisibilityProvider, ConversationRowScope } from './conversationVisibility';
import { JsonRender } from './JsonRender';
import { EMPTY_CONVERSATION_VISIBLE_RANGE } from './conversationListState';

test('json render parses when its row is near-visible', () => {
  const spec = '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"Hello viz"}}}}';
  const html = renderToStaticMarkup(
    createElement(
      ConversationVisibilityProvider,
      { range: { rowIds: ['message:1'], nearRowIds: [] } },
      createElement(
        ConversationRowScope,
        { rowId: 'message:1' },
        createElement(JsonRender, { source: spec }),
      ),
    ),
  );
  assert.match(html, /Hello viz/);
});

test('json render skips parse when the row is far outside the visible range', () => {
  const spec = '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"Hidden viz"}}}}';
  const html = renderToStaticMarkup(
    createElement(
      ConversationVisibilityProvider,
      { range: { rowIds: ['message:other'], nearRowIds: ['message:near'] } },
      createElement(
        ConversationRowScope,
        { rowId: 'message:1' },
        createElement(JsonRender, { source: spec }),
      ),
    ),
  );
  assert.match(html, /Visualization/);
  assert.doesNotMatch(html, /Hidden viz/);
});

test('an empty range fails open so the first paint still renders', () => {
  const spec = '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"First paint"}}}}';
  const html = renderToStaticMarkup(
    createElement(
      ConversationVisibilityProvider,
      { range: EMPTY_CONVERSATION_VISIBLE_RANGE },
      createElement(
        ConversationRowScope,
        { rowId: 'message:1' },
        createElement(JsonRender, { source: spec }),
      ),
    ),
  );
  assert.match(html, /First paint/);
});

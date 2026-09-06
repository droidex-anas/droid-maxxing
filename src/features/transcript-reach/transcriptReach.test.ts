import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptReachBar } from './TranscriptReachBar';
import { INITIAL_TRANSCRIPT_REACH_STATE, transcriptReachReducer } from './transcriptReachState';

test('next and previous wrap, including a single-match list', () => {
  const withMatches = transcriptReachReducer(INITIAL_TRANSCRIPT_REACH_STATE, {
    type: 'setMatches',
    query: 'foo',
    matches: [
      { rowId: 'message:a', itemKey: 'a', start: 0, end: 3, snippet: 'foo' },
      { rowId: 'message:b', itemKey: 'b', start: 0, end: 3, snippet: 'foo' },
    ],
  });
  const next = transcriptReachReducer(withMatches, { type: 'next' });
  assert.equal(next.activeIndex, 1);
  const wrapped = transcriptReachReducer(next, { type: 'next' });
  assert.equal(wrapped.activeIndex, 0);
  const prev = transcriptReachReducer(wrapped, { type: 'prev' });
  assert.equal(prev.activeIndex, 1);
});

test('range selection records a contiguous span from two row clicks', () => {
  const started = transcriptReachReducer(INITIAL_TRANSCRIPT_REACH_STATE, { type: 'beginRange' });
  const first = transcriptReachReducer(started, { type: 'selectRangeRow', itemKey: 'a' });
  const second = transcriptReachReducer(first, { type: 'selectRangeRow', itemKey: 'c' });
  assert.equal(second.rangeStartKey, 'a');
  assert.equal(second.rangeEndKey, 'c');
});

test('the find bar reports bounded loaded history instead of no matches', () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptReachBar, {
      state: {
        ...INITIAL_TRANSCRIPT_REACH_STATE,
        open: true,
        query: 'fn',
        committedQuery: 'fn',
      },
      dispatch: () => undefined,
      countLabel: 'No matches in loaded history',
      scopeNotice: { kind: 'older-history', empty: true },
      onLoadOlder: () => undefined,
      onCopyRange: () => undefined,
      copied: false,
    }),
  );
  assert.match(html, /No matches in loaded history/);
  assert.match(html, /Older history isn’t loaded/);
  assert.match(html, /Load older history/);
  assert.doesNotMatch(html, />No matches</);
});

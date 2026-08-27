import assert from 'node:assert/strict';
import test from 'node:test';

import { SIDEBAR_CONTENT_SEARCH_MIN_QUERY, sidebarSearchNotice } from './sidebarSearchStatus';

test('an unavailable index explains itself instead of a bare empty state', () => {
  assert.deepEqual(
    sidebarSearchNotice({
      queryLength: SIDEBAR_CONTENT_SEARCH_MIN_QUERY,
      pending: false,
      searchUnavailable: true,
      indexingIncomplete: false,
      entryCount: 0,
    }),
    { kind: 'unavailable', layout: 'empty' },
  );
});

test('unavailable search still labels title hits instead of looking complete', () => {
  assert.deepEqual(
    sidebarSearchNotice({
      queryLength: SIDEBAR_CONTENT_SEARCH_MIN_QUERY,
      pending: false,
      searchUnavailable: true,
      indexingIncomplete: false,
      entryCount: 2,
    }),
    { kind: 'unavailable', layout: 'inline' },
  );
});

test('partially indexed history is labelled incomplete beside results and empty sets', () => {
  assert.deepEqual(
    sidebarSearchNotice({
      queryLength: SIDEBAR_CONTENT_SEARCH_MIN_QUERY,
      pending: false,
      searchUnavailable: false,
      indexingIncomplete: true,
      entryCount: 1,
    }),
    { kind: 'indexing', layout: 'inline' },
  );
  assert.deepEqual(
    sidebarSearchNotice({
      queryLength: SIDEBAR_CONTENT_SEARCH_MIN_QUERY,
      pending: false,
      searchUnavailable: false,
      indexingIncomplete: true,
      entryCount: 0,
    }),
    { kind: 'indexing', layout: 'empty' },
  );
});

test('a complete empty search stays a plain empty state once indexing is done', () => {
  assert.deepEqual(
    sidebarSearchNotice({
      queryLength: SIDEBAR_CONTENT_SEARCH_MIN_QUERY,
      pending: false,
      searchUnavailable: false,
      indexingIncomplete: false,
      entryCount: 0,
    }),
    { kind: 'empty', layout: 'empty' },
  );
  assert.equal(
    sidebarSearchNotice({
      queryLength: SIDEBAR_CONTENT_SEARCH_MIN_QUERY,
      pending: false,
      searchUnavailable: false,
      indexingIncomplete: false,
      entryCount: 3,
    }),
    null,
  );
});

test('title-only queries do not claim content search is unavailable or incomplete', () => {
  assert.deepEqual(
    sidebarSearchNotice({
      queryLength: 1,
      pending: false,
      searchUnavailable: true,
      indexingIncomplete: true,
      entryCount: 0,
    }),
    { kind: 'empty', layout: 'empty' },
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';

import {
  SETTLED_MARKDOWN_CACHE_LIMIT,
  getSettledMarkdownElement,
  resetSettledMarkdownCacheForTest,
  settledMarkdownCacheKey,
  settledMarkdownCacheSize,
  settledMarkdownFlags,
} from './settledMarkdownCache';

test('settled cache returns the same element for the same key', () => {
  resetSettledMarkdownCacheForTest();
  const first = getSettledMarkdownElement('a:1:c', () => createElement('p', null, 'one'));
  const second = getSettledMarkdownElement('a:1:c', () => createElement('p', null, 'other'));
  assert.equal(second, first);
  assert.equal(settledMarkdownCacheSize(), 1);
});

test('settled cache is bounded and evicts the least recently used entry', () => {
  resetSettledMarkdownCacheForTest();
  for (let index = 0; index < SETTLED_MARKDOWN_CACHE_LIMIT + 5; index += 1) {
    getSettledMarkdownElement(`k:${String(index)}`, () =>
      createElement('span', null, String(index)),
    );
  }
  assert.equal(settledMarkdownCacheSize(), SETTLED_MARKDOWN_CACHE_LIMIT);
  const evicted = getSettledMarkdownElement('k:0', () =>
    createElement('span', null, 'replacement'),
  );
  assert.equal((evicted.props as { children: string }).children, 'replacement');
});

test('cache keys include identity, content hash, and render flags', () => {
  const flags = settledMarkdownFlags({
    specMode: false,
    allowGeneratedContent: true,
    autoPlayAppBlocks: false,
    cutOffAppBlocks: false,
  });
  const first = settledMarkdownCacheKey('row-1', 'Hello', flags);
  const second = settledMarkdownCacheKey('row-1', 'Hello!', flags);
  const otherRow = settledMarkdownCacheKey('row-2', 'Hello', flags);
  assert.notEqual(first, second);
  assert.notEqual(first, otherRow);
  assert.match(flags, /^cg--$/);
});

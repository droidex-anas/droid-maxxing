import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPath, displayPath, pathFileName } from './pathDisplay';

test('displayPath removes the session root from absolute edit paths', () => {
  assert.equal(
    displayPath(
      '/Users/anas/Documents/droid-control/src/components/chat.tsx',
      '/Users/anas/Documents/droid-control',
    ),
    'src/components/chat.tsx',
  );
});

test('displayPath keeps an absolute path useful when no root is available', () => {
  assert.equal(
    displayPath('/Users/anas/Documents/droid-control/src/components/chat.tsx'),
    '…/src/components/chat.tsx',
  );
});

test('compactPath normalizes separators and limits deep read rows', () => {
  assert.equal(compactPath('C:\\work\\packages\\ui\\src\\chat.tsx'), '…/ui/src/chat.tsx');
  assert.equal(compactPath('src/components/chat.tsx'), 'src/components/chat.tsx');
});

test('pathFileName returns only the final path segment', () => {
  assert.equal(pathFileName('…/src/components/chat.tsx'), 'chat.tsx');
  assert.equal(pathFileName('README.md'), 'README.md');
});

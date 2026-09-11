import assert from 'node:assert/strict';
import test from 'node:test';
import { repoPathInProse } from './prosePaths';

test('repoPathInProse claims file mentions and drops the line suffix', () => {
  assert.equal(repoPathInProse('docs/architecture.md'), 'docs/architecture.md');
  assert.equal(repoPathInProse('package.json'), 'package.json');
  assert.equal(repoPathInProse('src/components/ChatView.tsx:42'), 'src/components/ChatView.tsx');
  assert.equal(repoPathInProse(' src/lib/diff.ts:12:3 '), 'src/lib/diff.ts');
  assert.equal(repoPathInProse('src/components/transcript'), 'src/components/transcript');
});

test('repoPathInProse leaves ordinary inline code alone', () => {
  assert.equal(repoPathInProse('npm ci'), null);
  assert.equal(repoPathInProse('useState'), null);
  assert.equal(repoPathInProse('either/or'), null);
  assert.equal(repoPathInProse('src/**/*.ts'), null);
  assert.equal(repoPathInProse('https://example.com/a.md'), null);
  assert.equal(repoPathInProse('--no-verify'), null);
  assert.equal(repoPathInProse('src/lib/'), null);
  assert.equal(repoPathInProse('open(path)'), null);
});

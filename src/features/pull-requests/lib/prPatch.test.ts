import assert from 'node:assert/strict';
import test from 'node:test';
import { splitPrPatch } from './prPatch';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' keep',
  '+added',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
].join('\n');

test('splitPrPatch yields one file per git section with counts and status', () => {
  const files = splitPrPatch(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].file.path, 'src/a.ts');
  assert.equal(files[0].file.status, 'modified');
  assert.equal(files[0].file.additions, 1);
  assert.equal(files[1].file.path, 'src/gone.ts');
  assert.equal(files[1].file.status, 'deleted');
  assert.equal(files[1].file.deletions, 1);
});

test('a real binary section is binary, prose about binary files is not', () => {
  const files = splitPrPatch(
    [
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,1 +1,2 @@',
      ' intro',
      '+Binary files are stored with git-lfs.',
    ].join('\n'),
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].file.path, 'logo.png');
  assert.equal(files[0].file.binary, true);
  assert.equal(files[1].file.path, 'README.md');
  assert.equal(files[1].file.binary, false);
  assert.equal(files[1].file.additions, 1);
});

test('empty or header-only patches produce no files', () => {
  assert.deepEqual(splitPrPatch(''), []);
  assert.deepEqual(splitPrPatch('diff --git a/x b/x\n'), []);
});

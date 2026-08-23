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

test('git-quoted paths are decoded before they reach the file list', () => {
  const files = splitPrPatch(
    [
      'diff --git "a/src/\\303\\274ber.ts" "b/src/\\303\\274ber.ts"',
      '--- "a/src/\\303\\274ber.ts"',
      '+++ "b/src/\\303\\274ber.ts"',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+added',
      'diff --git "a/docs/read me.png" "b/docs/read me.png"',
      'Binary files "a/docs/read me.png" and "b/docs/read me.png" differ',
    ].join('\n'),
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].file.path, 'src/über.ts');
  // The quoted header alone carries the path for a binary section.
  assert.equal(files[1].file.path, 'docs/read me.png');
  assert.equal(files[1].file.binary, true);
});

test('metadata-only sections are listed with the status their mode lines report', () => {
  const files = splitPrPatch(
    [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/src/empty.ts b/src/empty.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/added.png b/added.png',
      'new file mode 100644',
      'index 0000000..1234567',
      'Binary files /dev/null and b/added.png differ',
      'diff --git a/gone.png b/gone.png',
      'deleted file mode 100644',
      'index 1234567..0000000',
      'Binary files a/gone.png and /dev/null differ',
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((entry) => [entry.file.path, entry.file.status]),
    [
      ['run.sh', 'modified'],
      ['src/empty.ts', 'added'],
      ['added.png', 'added'],
      ['gone.png', 'deleted'],
      ['new.ts', 'renamed'],
    ],
  );
});

test('empty or header-only patches produce no files', () => {
  assert.deepEqual(splitPrPatch(''), []);
  assert.deepEqual(splitPrPatch('diff --git a/x b/x\n'), []);
});

test('a GIT binary patch section is binary even though it has no hunks', () => {
  const files = splitPrPatch(
    [
      'diff --git a/logo.png b/logo.png',
      'index 0ff1ce..baddad 100644',
      'GIT binary patch',
      'literal 42',
      'zcmV+vhJ6zXw$a?FC',
      '',
    ].join('\n'),
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].file.path, 'logo.png');
  assert.equal(files[0].file.binary, true);
});

test('literal astral characters in a quoted path decode as whole code points', () => {
  const files = splitPrPatch(
    [
      'diff --git "a/emoji 🚀.png" "b/emoji 🚀.png"',
      '--- "a/emoji 🚀.png"',
      '+++ "b/emoji 🚀.png"',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+added',
    ].join('\n'),
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].file.path, 'emoji 🚀.png');
});

test('metadata paths containing the destination prefix are not truncated', () => {
  const files = splitPrPatch(
    [
      'diff --git a/docs/a b/example.txt b/docs/a b/example.txt',
      'old mode 100644',
      'new mode 100755',
    ].join('\n'),
  );

  assert.equal(files.length, 1);
  assert.equal(files[0].file.path, 'docs/a b/example.txt');
});

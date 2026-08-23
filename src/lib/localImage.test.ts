import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageSrc,
  isImagePath,
  localImageFilePath,
  partitionImagePaths,
  pathBaseName,
} from './localImage';

test('isImagePath accepts known extensions and rejects everything else', () => {
  assert.equal(isImagePath('/tmp/a.PNG'), true);
  assert.equal(isImagePath('/tmp/a.webp'), true);
  assert.equal(isImagePath('/tmp/a.txt'), false);
  assert.equal(isImagePath('/tmp/paste-1712'), false);
});

test('pathBaseName drops directories and query strings', () => {
  assert.equal(pathBaseName('/var/folders/T/paste-1-ab.png'), 'paste-1-ab.png');
  assert.equal(pathBaseName('https://x.test/a/b.png?v=2'), 'b.png');
  assert.equal(pathBaseName('shot.png'), 'shot.png');
});

test('pathBaseName reads the file name back out of a droidex-img URL', () => {
  assert.equal(pathBaseName('droidex-img://local/?p=%2Ftmp%2Fattach%2Fpaste-1.png'), 'paste-1.png');
  assert.equal(
    pathBaseName('droidex-img://local/?p=%2Ftmp%2Fattach%2Fpaste%23final%3F.png'),
    'paste#final?.png',
  );
});

test('scheme matching ignores case', () => {
  assert.equal(imageSrc('HTTPS://x.test/a.png'), 'HTTPS://x.test/a.png');
  assert.equal(localImageFilePath('FILE:///tmp/a.png'), '/tmp/a.png');
});

test('partitionImagePaths splits attachments and keeps each order', () => {
  const { images, files } = partitionImagePaths([
    '/tmp/b.png',
    '/src/index.ts',
    '/tmp/a.jpeg',
    '/README.md',
  ]);
  assert.deepEqual(images, ['/tmp/b.png', '/tmp/a.jpeg']);
  assert.deepEqual(files, ['/src/index.ts', '/README.md']);
});

test('localImageFilePath resolves absolute, ~ and file:// references only', () => {
  assert.equal(localImageFilePath('/tmp/a.png'), '/tmp/a.png');
  assert.equal(localImageFilePath('~/shots/a.png'), '~/shots/a.png');
  assert.equal(localImageFilePath('file:///tmp/a%20b.png'), '/tmp/a b.png');
  assert.equal(localImageFilePath('/tmp/a.png?v=2'), '/tmp/a.png');
  assert.equal(localImageFilePath('./docs/a.png'), null);
  assert.equal(localImageFilePath('https://x.test/a.png'), null);
});

test('imageSrc passes remote and inline sources through untouched', () => {
  assert.equal(imageSrc('https://x.test/a.png'), 'https://x.test/a.png');
  assert.equal(imageSrc('data:image/png;base64,AA'), 'data:image/png;base64,AA');
});

test('imageSrc rewrites a local path to the desktop image scheme', () => {
  assert.equal(
    imageSrc('/Users/me/Screen Shots/a b.png'),
    'droidex-img://local/?p=%2FUsers%2Fme%2FScreen%20Shots%2Fa%20b.png',
  );
});

test('a repo-relative image is an image with no displayable source', () => {
  // What the @ menu attaches: listFiles returns paths relative to the repo root.
  // Both halves must hold, because the composer picks its chip on exactly this
  // pair and used to drop the attachment when the src was null.
  assert.equal(isImagePath('assets/hero.png'), true);
  assert.equal(imageSrc('assets/hero.png'), null);
});

test('imageSrc refuses references it cannot resolve or display', () => {
  assert.equal(imageSrc('./relative/a.png'), null);
  assert.equal(imageSrc('/tmp/notes.txt'), null);
  assert.equal(imageSrc('   '), null);
});

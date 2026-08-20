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

test('imageSrc refuses references it cannot resolve or display', () => {
  assert.equal(imageSrc('./relative/a.png'), null);
  assert.equal(imageSrc('/tmp/notes.txt'), null);
  assert.equal(imageSrc('   '), null);
});

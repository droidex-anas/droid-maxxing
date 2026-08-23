const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  LOCAL_IMAGE_SCHEME,
  imageMimeForPath,
  localImageRequestPath,
  readLocalImage,
} = require('./localImages.cjs');

function requestUrl(filePath) {
  return `${LOCAL_IMAGE_SCHEME}://local/?p=${encodeURIComponent(filePath)}`;
}

test('imageMimeForPath maps known extensions case-insensitively', () => {
  assert.equal(imageMimeForPath('/tmp/a.PNG'), 'image/png');
  assert.equal(imageMimeForPath('/tmp/a.jpeg'), 'image/jpeg');
  assert.equal(imageMimeForPath('/tmp/a.svg'), 'image/svg+xml');
  assert.equal(imageMimeForPath('/tmp/a.txt'), null);
  assert.equal(imageMimeForPath('/tmp/noextension'), null);
});

test('localImageRequestPath round-trips a path containing spaces and slashes', () => {
  const target = '/Users/me/Screen Shots/a b/c.png';
  assert.equal(localImageRequestPath(requestUrl(target)), target);
});

test('localImageRequestPath expands a leading ~', () => {
  assert.equal(
    localImageRequestPath(requestUrl('~/shots/a.png'), '/Users/me'),
    '/Users/me/shots/a.png',
  );
});

test('localImageRequestPath refuses another scheme, a missing path, and a relative path', () => {
  assert.throws(() => localImageRequestPath('file:///tmp/a.png'), /Unsupported scheme/);
  assert.throws(() => localImageRequestPath(`${LOCAL_IMAGE_SCHEME}://local/`), /missing a path/);
  assert.throws(() => localImageRequestPath(requestUrl('shots/a.png')), /must be absolute/);
});

test('readLocalImage returns the bytes and mime of a supported file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-images-test-'));
  const target = path.join(dir, 'shot.png');
  await fsp.writeFile(target, 'pixels');
  assert.deepEqual(await readLocalImage(target), {
    mime: 'image/png',
    data: Buffer.from('pixels'),
  });
});

test('readLocalImage refuses an unsupported type, a directory, and an oversize file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-images-test-'));
  const notes = path.join(dir, 'notes.txt');
  await fsp.writeFile(notes, 'text');
  const big = path.join(dir, 'big.png');
  await fsp.writeFile(big, 'pixels');
  await assert.rejects(readLocalImage(notes), /Unsupported image type/);
  await assert.rejects(readLocalImage(path.join(dir, 'nested.png')), /ENOENT/);
  await assert.rejects(readLocalImage(big, { maxBytes: 2 }), /size limit/);
});

test('readLocalImage reads no more than the size it validated', async () => {
  // The file grows after the descriptor is inspected: the read must stay bounded
  // by the validated size instead of pulling in whatever the file became.
  let requestedLength = null;
  const fs = {
    open: async () => ({
      stat: async () => ({ isFile: () => true, size: 6 }),
      read: async (buffer, offset, length) => {
        requestedLength = length;
        Buffer.from('pixels-and-then-some').copy(buffer, offset, 0, length);
        return { bytesRead: length };
      },
      close: async () => {},
    }),
  };
  assert.deepEqual(await readLocalImage('/tmp/grows.png', { fs }), {
    mime: 'image/png',
    data: Buffer.from('pixels'),
  });
  assert.equal(requestedLength, 6);
});

test('readLocalImage refuses a body that ends before its reported size', async () => {
  const fs = {
    open: async () => ({
      stat: async () => ({ isFile: () => true, size: 10 }),
      read: async (buffer, offset, length) => {
        // A short read followed by EOF: a truncated file, not a smaller image.
        if (offset > 0) return { bytesRead: 0 };
        Buffer.from('pix').copy(buffer, offset, 0, Math.min(3, length));
        return { bytesRead: 3 };
      },
      close: async () => {},
    }),
  };
  await assert.rejects(readLocalImage('/tmp/truncated.png', { fs }), /ended before the size/);
});

test('readLocalImage refuses a path that is not a regular file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-images-test-'));
  const asDir = path.join(dir, 'weird.png');
  await fsp.mkdir(asDir);
  await assert.rejects(readLocalImage(asDir), /Not a regular file/);
});

/**
 * Local image source for the renderer.
 *
 * The renderer runs from http://localhost in dev and file:// when packaged, so
 * an `<img src="/Users/me/shot.png">` either 404s or resolves against the wrong
 * root. Transcript images (assistant markdown, pasted attachments) therefore go
 * through the `droidex-img://` scheme, whose URLs carry the absolute path in a
 * query parameter so Chromium never path-normalizes it.
 *
 * Reading is deliberately narrow: a real regular file, a known image extension,
 * and a size cap. It is registered only on the default session, so pages loaded
 * in the Browser pane (a separate partition) cannot reach local files with it.
 *
 * Kept free of `require('electron')` so it can be unit-tested under plain Node.
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LOCAL_IMAGE_SCHEME = 'droidex-img';

// Mirrors LOCAL_IMAGE_MIMES in src/lib/localImage.ts: the renderer only builds
// URLs for types this handler is willing to serve.
const MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
]);

// Same ceiling as pasted attachments: generous for retina screenshots, small
// enough that a bogus request cannot pull a huge file into memory.
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function imageMimeForPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXTENSION.get(ext) ?? null;
}

/**
 * Extracts the absolute file path from a `droidex-img://` URL, or throws when
 * the URL is not one we issued. `~` is expanded so markdown written by an agent
 * ("~/.factory/temp/shot.png") resolves the same way the shell would.
 */
function localImageRequestPath(requestUrl, homeDir = os.homedir()) {
  const url = new URL(requestUrl);
  if (url.protocol !== `${LOCAL_IMAGE_SCHEME}:`) {
    throw new Error(`Unsupported scheme: ${url.protocol}`);
  }
  const raw = url.searchParams.get('p');
  if (!raw) throw new Error('Local image request is missing a path');
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(homeDir, raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error('Local image path must be absolute');
  return path.normalize(expanded);
}

/**
 * Reads an image file for the protocol handler. Rejects anything that is not a
 * regular file of a supported type within the size cap; a symlink is followed
 * (open, not lstat) because screenshot tools legitimately link into temp dirs,
 * and the renderer could read the target through the existing read-file IPC
 * anyway.
 *
 * The file is inspected and read through one descriptor, and the read is bounded
 * by the cap, so a file that is replaced or grown between the check and the read
 * cannot pull more than the cap into memory.
 */
async function readLocalImage(filePath, { maxBytes = MAX_IMAGE_BYTES, fs = fsp } = {}) {
  const mime = imageMimeForPath(filePath);
  if (!mime) throw new Error(`Unsupported image type: ${path.basename(filePath)}`);
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Not a regular file');
    if (stats.size > maxBytes) throw new Error('Image exceeds the size limit');
    const buffer = Buffer.alloc(Number(stats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { mime, data: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

module.exports = {
  LOCAL_IMAGE_SCHEME,
  MAX_IMAGE_BYTES,
  imageMimeForPath,
  localImageRequestPath,
  readLocalImage,
};

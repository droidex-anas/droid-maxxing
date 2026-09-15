const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { png, rect, MAX_IMAGE_BYTES } = require('./validation.cjs');

function captureArguments(mode, destination) {
  if (mode === 'area') return ['-x', '-i', '-s', '-t', 'png', destination];
  if (mode === 'window') return ['-x', '-i', '-w', '-o', '-t', 'png', destination];
  if (mode === 'screen') return ['-x', '-m', '-t', 'png', destination];
  throw new Error('Unknown capture mode');
}
function runCapture(args, signal, execute = execFile) {
  return new Promise((resolve, reject) => {
    execute(
      '/usr/sbin/screencapture',
      args,
      { signal, timeout: 180_000, maxBuffer: 32_768 },
      (error) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      },
    );
  });
}
async function captureNative(mode, signal) {
  if (process.platform !== 'darwin')
    throw new Error(
      'Desktop snipping currently requires macOS. Image import and editing are available here.',
    );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'droidex-capture-'));
  await fs.chmod(dir, 0o700);
  const destination = path.join(dir, 'capture.png');
  try {
    let captureError;
    try {
      if (!(await runCapture(captureArguments(mode, destination), signal))) return null;
    } catch (error) {
      captureError = error;
    }
    if (signal.aborted) return null;
    const stat = await fs.stat(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // macOS returns 1 and creates no file when the user presses Escape.
    if (!stat || stat.size === 0) {
      if (captureError && captureError.code !== 1)
        throw new Error(
          'Screen capture failed. Check macOS Screen Recording permission and try again.',
          { cause: captureError },
        );
      return null;
    }
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('Screenshot exceeds the 40 MiB limit');
    const buffer = await fs.readFile(destination);
    png(buffer);
    return buffer;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function captureComponent(contents, selection) {
  const bounds = await contents.executeJavaScript('({width:innerWidth,height:innerHeight})');
  const box = rect(selection, bounds.width, bounds.height);
  const zoom = contents.getZoomFactor();
  const dipBox = {
    x: Math.floor(box.x * zoom),
    y: Math.floor(box.y * zoom),
    width: Math.ceil(box.width * zoom),
    height: Math.ceil(box.height * zoom),
  };
  const image = await contents.capturePage(dipBox);
  if (image.isEmpty()) throw new Error('The selected component could not be captured');
  const buffer = image.toPNG({ scaleFactor: Math.max(1, ...image.getScaleFactors()) });
  png(buffer);
  return buffer;
}
module.exports = { captureArguments, runCapture, captureNative, captureComponent };

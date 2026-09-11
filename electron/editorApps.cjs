/**
 * The apps DROIDEX can hand a project to: which ones this machine has, and what
 * each one actually looks like.
 *
 * Icons are the installed application's own icon, read from its bundle by
 * macOS, so the picker shows Cursor's real mark rather than a drawing of it.
 * The reader is Quick Look rather than `app.getFileIcon`, which on macOS hands
 * back the generic bundle placeholder for every app and hangs the main process
 * outright when asked for its 'large' size. 64px covers a 16px mark on retina,
 * and an installed app's icon does not change under us, so each one is read
 * once and kept for the life of the process.
 */

const { nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')];

function userInstalled(...bundleNames) {
  return bundleNames.flatMap((name) => APP_DIRS.map((dir) => path.join(dir, name)));
}

// Where each launch target lives on macOS, most preferred bundle first.
const MAC_BUNDLES = {
  vscode: userInstalled('Visual Studio Code.app'),
  cursor: userInstalled('Cursor.app'),
  finder: ['/System/Library/CoreServices/Finder.app'],
  terminal: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
  xcode: userInstalled('Xcode.app'),
};

const iconsByEditor = new Map();

function macBundlePath(editor) {
  return MAC_BUNDLES[editor]?.find((bundle) => fs.existsSync(bundle)) ?? null;
}

function commandOnPath(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Which launch targets are installed, so the UI only offers ones that open. */
function listEditors() {
  const editors = [];
  if (process.platform === 'darwin') {
    if (macBundlePath('vscode')) editors.push('vscode');
    if (macBundlePath('cursor')) editors.push('cursor');
    editors.push('finder', 'terminal');
    if (macBundlePath('xcode')) editors.push('xcode');
    return editors;
  }
  if (commandOnPath('code')) editors.push('vscode');
  if (commandOnPath('cursor')) editors.push('cursor');
  editors.push('finder');
  if (process.platform === 'win32' || commandOnPath('x-terminal-emulator'))
    editors.push('terminal');
  return editors;
}

async function readIcon(editor) {
  const bundle = macBundlePath(editor);
  if (!bundle) return null;
  const icon = await nativeImage.createThumbnailFromPath(bundle, { width: 64, height: 64 });
  return icon.isEmpty() ? null : icon.toDataURL();
}

/**
 * The app's own icon as a PNG data URL, or null when this machine has no bundle
 * to read it from and the UI should fall back to its own glyph.
 */
function editorIcon(editor) {
  if (process.platform !== 'darwin' || !Object.hasOwn(MAC_BUNDLES, editor)) {
    return Promise.resolve(null);
  }
  let pending = iconsByEditor.get(editor);
  if (!pending) {
    pending = readIcon(editor).catch(() => null);
    iconsByEditor.set(editor, pending);
  }
  return pending;
}

module.exports = { listEditors, editorIcon };

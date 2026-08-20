// Turns a local image reference (absolute path, ~-path, or file:// URL) into a
// URL the renderer can actually load. Absolute paths cannot be used directly:
// the renderer origin is http://localhost in dev and file:// when packaged, so
// they resolve against the wrong root. The desktop app serves them through the
// droidex-img scheme instead (electron/localImages.cjs).

const LOCAL_IMAGE_SCHEME = 'droidex-img';

// Must mirror MIME_BY_EXTENSION in electron/localImages.cjs: a URL for any other
// type would only ever come back 404.
const LOCAL_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'];

/** Last segment of a path or URL, used as the display label for an image. */
export function pathBaseName(reference: string): string {
  const withoutQuery = reference.split(/[?#]/)[0];
  const slash = withoutQuery.lastIndexOf('/');
  return slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
}

/** True when the path or URL ends in an image extension the app can display. */
export function isImagePath(reference: string): boolean {
  const withoutQuery = reference.split(/[?#]/)[0];
  const ext = withoutQuery.slice(withoutQuery.lastIndexOf('.') + 1).toLowerCase();
  return withoutQuery.includes('.') && LOCAL_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Splits attachment paths into displayable images and everything else, keeping
 * each group in its original order. Prompts carry both kinds in one list, so
 * every surface that shows attachments (composer chips, queued rows) needs the
 * same split to render images as thumbnails and the rest as file chips.
 */
export function partitionImagePaths(paths: readonly string[]): {
  images: string[];
  files: string[];
} {
  const images: string[] = [];
  const files: string[] = [];
  for (const path of paths) (isImagePath(path) ? images : files).push(path);
  return { images, files };
}

/** Absolute filesystem path behind a reference, or null when it is not local. */
export function localImageFilePath(reference: string): string | null {
  if (reference.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(reference).pathname) || null;
    } catch {
      return null;
    }
  }
  if (reference.startsWith('/') || reference.startsWith('~/')) {
    // Agent markdown sometimes cache-busts an image ("/tmp/a.png?v=2"); the
    // suffix is not part of the file name and would turn the read into ENOENT.
    return reference.split(/[?#]/)[0];
  }
  return null;
}

/**
 * Loadable src for an image reference, or null when it cannot be displayed.
 * Remote and inline sources pass through untouched; local paths are rewritten to
 * the droidex-img scheme. Relative paths are refused: there is no single root to
 * resolve them against, so guessing would produce silent broken images.
 */
export function imageSrc(reference: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  if (/^(https?:|data:|blob:|droidex-img:)/.test(trimmed)) return trimmed;
  const filePath = localImageFilePath(trimmed);
  if (filePath === null || !isImagePath(filePath)) return null;
  return `${LOCAL_IMAGE_SCHEME}://local/?p=${encodeURIComponent(filePath)}`;
}

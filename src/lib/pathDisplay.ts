import { comparablePath, normalizePath } from './pathComparison';

const COMPACT_SEGMENT_COUNT = 3;

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function withoutTrailingSlash(path: string): string {
  if (path === '/' || /^[A-Za-z]:\/$/.test(path)) return path;
  return path.replace(/\/+$/, '');
}

function tailPath(path: string, segmentCount: number): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= segmentCount) return segments.join('/');
  return `…/${segments.slice(-segmentCount).join('/')}`;
}

// Display paths relative to the session folder when possible. Absolute paths
// that cannot be related to the session are reduced to their useful tail; the
// complete value remains available through the caller's title tooltip.
export function displayPath(path: string, cwd?: string): string {
  const raw = path.trim();
  if (!raw) return '';

  const normalized = normalizePath(raw);
  const root = cwd ? withoutTrailingSlash(normalizePath(cwd)) : '';
  if (root && comparablePath(normalized) === comparablePath(root)) return '.';
  const prefix = root && (root.endsWith('/') ? root : `${root}/`);
  const comparedRoot = comparablePath(root);
  const comparedPrefix = comparedRoot.endsWith('/') ? comparedRoot : `${comparedRoot}/`;
  if (prefix && comparablePath(normalized).startsWith(comparedPrefix)) {
    return normalized.slice(prefix.length);
  }
  if (!isAbsolutePath(normalized)) return normalized;
  return tailPath(normalized, COMPACT_SEGMENT_COUNT);
}

// Read rows are intentionally denser than file-review headers, so they always
// use a short tail even when the input is already relative.
export function compactPath(path: string): string {
  const raw = path.trim();
  if (!raw) return '';
  const normalized = normalizePath(raw);
  if (normalized === '.') return '.';
  return tailPath(normalized, COMPACT_SEGMENT_COUNT) || normalized;
}

export function pathFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

// Return a workspace-relative path for the root-bound Files preview API.
// Its host-side realpath checks also reject symlink escapes before reading.
export function relativeWorkspaceFilePath(path: string, cwd: string): string {
  const file = normalizePath(path);
  const root = withoutTrailingSlash(normalizePath(cwd));
  if (!path.trim() || !cwd.trim() || !isAbsolutePath(root) || !file || file === '.') {
    throw new Error('A workspace folder and file path are required for preview.');
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const target = isAbsolutePath(file) ? file : normalizePath(`${prefix}${file}`);
  const comparedRoot = comparablePath(root);
  const comparedPrefix = comparedRoot.endsWith('/') ? comparedRoot : `${comparedRoot}/`;
  if (!comparablePath(target).startsWith(comparedPrefix)) {
    throw new Error('File preview path is outside the workspace.');
  }
  return target.slice(prefix.length);
}

import { parseUnifiedDiff } from '../../../lib/unifiedDiff';
import type { DiffFile, DiffFileStatus } from '../../../types/vcs';

export interface PrPatchFile {
  file: DiffFile;
  diff: string;
}

function stripAbPrefix(value: string): string {
  const path = value.replace(/\t.*$/, '');
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function filePathFromChunk(chunk: string): string | null {
  const plus = /^\+\+\+ (.+)$/m.exec(chunk);
  if (plus && plus[1] !== '/dev/null') return stripAbPrefix(plus[1]);
  const minus = /^--- (.+)$/m.exec(chunk);
  if (minus && minus[1] !== '/dev/null') return stripAbPrefix(minus[1]);
  // Binary and 100% rename chunks often omit ---/+++. Header-only sections
  // stay empty so `diff --git a/x b/x` does not invent a file.
  if (chunk.includes('Binary files') || /^rename from /m.test(chunk)) {
    const git = /^diff --git a\/(.+) b\/(.+)$/m.exec(chunk);
    if (git) return git[2];
  }
  return null;
}

function statusFromChunk(chunk: string): DiffFileStatus {
  if (/^--- \/dev\/null$/m.test(chunk)) return 'added';
  if (/^\+\+\+ \/dev\/null$/m.test(chunk)) return 'deleted';
  if (/^rename from /m.test(chunk)) return 'renamed';
  return 'modified';
}

export function splitPrPatch(diff: string): PrPatchFile[] {
  if (!diff) return [];
  const chunks = diff.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '));
  const files: PrPatchFile[] = [];
  for (const chunk of chunks) {
    const path = filePathFromChunk(chunk);
    if (!path) continue;
    const parsed = parseUnifiedDiff(chunk);
    files.push({
      file: {
        path,
        status: statusFromChunk(chunk),
        additions: parsed.additions,
        deletions: parsed.deletions,
        binary: chunk.includes('Binary files') || parsed.binary,
      },
      diff: chunk,
    });
  }
  return files;
}

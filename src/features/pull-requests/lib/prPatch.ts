import { parseUnifiedDiff } from '../../../lib/unifiedDiff';
import type { DiffFile, DiffFileStatus } from '../../../types/vcs';

export interface PrPatchFile {
  file: DiffFile;
  diff: string;
}

const C_ESCAPES: Record<string, number | undefined> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

// Git quotes a path that holds non-ASCII bytes, a quote, a backslash, or a
// control character (core.quotePath), and GitHub also quotes spaces. The escapes
// are C-style over raw bytes, so octal escapes are collected as bytes and
// decoded as UTF-8 together: `"a/\303\274ber.ts"` is `a/über.ts`.
function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let index = 0;
  while (index < inner.length) {
    // Literal characters are encoded one code point at a time: splitting a
    // surrogate pair in half would decode back as replacement characters.
    const codePoint = inner.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    index += char.length;
    if (char !== '\\') {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(index, index + 3));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      index += octal[0].length;
      continue;
    }
    const next = inner[index] ?? '';
    const escaped = C_ESCAPES[next];
    if (escaped === undefined) bytes.push(...encoder.encode(next));
    else bytes.push(escaped);
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripAbPrefix(value: string): string {
  const path = unquoteGitPath(value.replace(/\t.*$/, ''));
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

const QUOTED_GIT_HEADER = /^diff --git (?:"a\/(?:\\.|[^"\\])*") ("b\/(?:\\.|[^"\\])*")$/m;

function gitHeaderDestination(chunk: string): string | null {
  const quoted = QUOTED_GIT_HEADER.exec(chunk);
  if (quoted) return stripAbPrefix(quoted[1]);
  const line = /^diff --git (a\/.*)$/m.exec(chunk)?.[1];
  if (!line) return null;
  const candidates: { source: string; destination: string }[] = [];
  let separator = line.indexOf(' b/');
  while (separator >= 0) {
    candidates.push({
      source: line.slice(0, separator),
      destination: line.slice(separator + 1),
    });
    separator = line.indexOf(' b/', separator + 1);
  }
  const samePath = candidates.find(
    ({ source, destination }) => stripAbPrefix(source) === stripAbPrefix(destination),
  );
  return samePath ? stripAbPrefix(samePath.destination) : null;
}

// Git metadata that describes a change on its own: mode flips, empty new or
// deleted files, rename or copy records, and binary blobs all arrive without
// ---/+++ lines.
// A base85-encoded blob section carries no hunk headers at all, so the
// unified parser cannot recognize it as binary.
const GIT_BINARY_PATCH = /^GIT binary patch$/m;

const GIT_METADATA =
  /^(?:old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch)/m;

function filePathFromChunk(chunk: string): string | null {
  const plus = /^\+\+\+ (.+)$/m.exec(chunk);
  if (plus && plus[1] !== '/dev/null') return stripAbPrefix(plus[1]);
  const minus = /^--- (.+)$/m.exec(chunk);
  if (minus && minus[1] !== '/dev/null') return stripAbPrefix(minus[1]);
  // Metadata-only sections still changed a file, so their path comes from the
  // git header. A header with nothing under it stays empty so `diff --git a/x
  // b/x` does not invent a file. Anchored: a textual line inside a hunk
  // mentioning binary files is content, not git's own marker.
  if (GIT_METADATA.test(chunk)) {
    const rename = /^rename to (.+)$/m.exec(chunk)?.[1];
    if (rename) return unquoteGitPath(rename);
    const copy = /^copy to (.+)$/m.exec(chunk)?.[1];
    if (copy) return unquoteGitPath(copy);
    return gitHeaderDestination(chunk);
  }
  return null;
}

// Binary and empty-file sections carry no /dev/null content header, so the mode
// lines are what say the file appeared or disappeared.
function statusFromChunk(chunk: string): DiffFileStatus {
  if (/^--- \/dev\/null$/m.test(chunk) || /^new file mode /m.test(chunk)) return 'added';
  if (/^\+\+\+ \/dev\/null$/m.test(chunk) || /^deleted file mode /m.test(chunk)) return 'deleted';
  if (/^rename from /m.test(chunk)) return 'renamed';
  if (/^copy from /m.test(chunk)) return 'copied';
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
        binary: parsed.binary || GIT_BINARY_PATCH.test(chunk),
      },
      diff: chunk,
    });
  }
  return files;
}

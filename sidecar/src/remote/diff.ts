import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RemoteChange } from './types.js';

const execute = promisify(execFile);
const BYTE_LIMIT = 256 * 1024;
const FILE_LIMIT = 30;

// This is a working-tree review, not a claim that every edit came from this turn.
export async function readWorkspaceDiff(cwd: string): Promise<{ changes: RemoteChange[]; note: string }> {
  try {
    const options = { cwd, maxBuffer: BYTE_LIMIT, timeout: 5_000, windowsHide: true };
    const { stdout } = await execute('git', [
      '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', 'HEAD', '--', '.',
    ], options);
    const changes = parseDiff(stdout).slice(0, FILE_LIMIT);
    const { stdout: untracked } = await execute('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z', '--', '.'], options);
    let remaining = BYTE_LIMIT - Buffer.byteLength(stdout);
    let omitted = stdout.includes('Binary files ') || stdout.includes('GIT binary patch') || stdout.includes('diff --git "') || parseDiff(stdout).length > FILE_LIMIT;
    for (const name of untracked.split('\0').filter(Boolean)) {
      if (changes.length >= FILE_LIMIT || remaining <= 0) { omitted = true; break; }
      const candidate = resolve(cwd, name);
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.size > remaining) { omitted = true; continue; }
      const target = await realpath(candidate);
      const relation = relative(cwd, target);
      if (relation.startsWith('..') || isAbsolute(relation)) { omitted = true; continue; }
      const data = await readFile(target);
      if (data.includes(0)) { omitted = true; continue; }
      remaining -= data.length;
      const lines = data.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      changes.push({ path: name, lines: lines.map((line) => ({ kind: 'addition', text: line })) });
    }
    let lineBudget = 4_000;
    for (const change of changes) {
      if (change.lines.length > lineBudget) { change.lines = change.lines.slice(0, lineBudget); omitted = true; }
      lineBudget -= change.lines.length;
    }
    return {
      changes: changes.filter((change) => change.lines.length > 0),
      note: 'Working-tree changes, including existing edits. Nothing is applied by this viewer.'
        + (omitted ? ' Some large, binary, or additional files are omitted.' : ''),
    };
  } catch {
    return { changes: [], note: 'Diff unavailable. Use a Git repository with an initial commit; large diffs must be reviewed on the computer.' };
  }
}

export function parseDiff(patch: string): RemoteChange[] {
  const changes: RemoteChange[] = [];
  let file: RemoteChange | undefined;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = undefined;
      inHunk = false;
    } else if (line.startsWith('--- a/')) {
      file = { path: line.slice(6), lines: [] };
      changes.push(file);
    } else if (line.startsWith('+++ b/')) {
      if (!file) { file = { path: line.slice(6), lines: [] }; changes.push(file); }
      else file.path = line.slice(6);
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (file && inHunk && /^[ +\-]/.test(line)) {
      file.lines.push({ kind: line[0] === '+' ? 'addition' : line[0] === '-' ? 'deletion' : 'context', text: line.slice(1) });
    }
  }
  return changes.filter((change) => change.lines.length > 0);
}

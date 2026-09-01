import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AutomationExecutionMode } from './types.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface PrepareAutomationWorkspaceInput {
  cwd: string | null;
  executionMode: AutomationExecutionMode;
  title: string;
  runId: string;
}

/** The part of a run that decides whether a workspace has to be cleaned up. */
export interface ReleasableAutomationWorkspace {
  resolvedCwd: string | null;
  executionMode: AutomationExecutionMode;
}

export type AutomationWorkspacePreparer = (
  input: PrepareAutomationWorkspaceInput,
) => Promise<string>;

export type AutomationWorkspaceReleaser = (
  workspace: ReleasableAutomationWorkspace,
) => Promise<void>;

/**
 * Resolve the directory used by a scheduled run. Local runs use the selected
 * checkout directly. Isolated runs create a detached worktree without going
 * through renderer IPC, so they can start while the Automations screen is closed.
 */
export async function prepareAutomationWorkspace(
  input: PrepareAutomationWorkspaceInput,
): Promise<string> {
  const selected = input.cwd?.trim() ?? '';
  if (!selected) return '';
  await requireDirectory(selected);
  if (input.executionMode === 'local') return selected;

  const root = await git(selected, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!root) {
    throw new Error('An isolated worktree can only be created for a Git repository.');
  }
  const commit = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
  if (!commit) throw new Error('The selected repository does not have a commit to run from.');

  const name = automationWorktreeName(input.title, input.runId);
  let target = detachedWorktreePath(root, name);
  for (let suffix = 2; existsSync(target); suffix += 1) {
    target = detachedWorktreePath(root, `${name}-${String(suffix)}`);
  }

  await ensureWorktreeDirectoryIgnored(root);
  await requireRealDirectoryPath(root, target);
  await mkdir(dirname(target), { recursive: true });
  try {
    await git(root, ['worktree', 'add', '--detach', target, commit], 90_000);
  } catch (error) {
    throw new Error(`Could not create the automation worktree: ${errorMessage(error)}`);
  }
  return target;
}

/**
 * Removes a run's isolated worktree once it has settled. A worktree holding
 * uncommitted or untracked work is kept: the automation's output lives there and
 * DROIDEX must not delete it.
 */
export async function releaseAutomationWorkspace(
  run: ReleasableAutomationWorkspace,
): Promise<void> {
  const target = run.resolvedCwd?.trim() ?? '';
  if (run.executionMode !== 'worktree' || !target || !existsSync(target)) return;
  try {
    const commonDir = await git(target, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const root = basename(commonDir) === '.git' ? dirname(commonDir) : '';
    if (!root || resolve(target) === resolve(root)) return;
    if (await git(target, ['status', '--porcelain'])) return;
    await git(root, ['worktree', 'remove', target]);
    await git(root, ['worktree', 'prune']);
    await rmdir(dirname(target)).catch(() => undefined);
  } catch (error) {
    console.error('Could not remove the automation worktree', errorMessage(error));
  }
}

export function automationWorktreeName(title: string, runId: string): string {
  const suffix = sanitizeSegment(runId).slice(-6) || 'run';
  const intent = sanitizeSegment(title).slice(0, Math.max(8, 54 - suffix.length)) || 'automation';
  return `${intent}-${suffix}`;
}

function detachedWorktreePath(root: string, name: string): string {
  return join(root, '.worktrees', name, basename(root));
}

async function requireDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch {
    // The clear error below is shared by missing files and non-directories.
  }
  throw new Error('The selected automation workspace no longer exists.');
}

/**
 * Rejects a worktree path that leaves the repository through a symbolic link, so
 * a planted `.worktrees` link cannot redirect an automation's writes elsewhere.
 */
async function requireRealDirectoryPath(root: string, target: string): Promise<void> {
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('The automation worktree path must stay inside the selected repository.');
  }
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (!entry) return;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        `Could not create the automation worktree because ${current} is not a real directory. Remove or rename it and run the automation again.`,
      );
    }
  }
}

async function ensureWorktreeDirectoryIgnored(root: string): Promise<void> {
  try {
    const commonDirRaw = await git(root, ['rev-parse', '--git-common-dir']);
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(root, commonDirRaw);
    const excludePath = join(commonDir, 'info', 'exclude');
    let contents = '';
    try {
      contents = await readFile(excludePath, 'utf8');
    } catch {
      // The file is optional and can be created lazily.
    }
    if (/^\/?\.worktrees\/?$/m.test(contents)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    const prefix = contents && !contents.endsWith('\n') ? '\n' : '';
    await appendFile(excludePath, `${prefix}/.worktrees/\n`, 'utf8');
  } catch {
    // Ignoring the folder is best effort; worktree creation remains authoritative.
  }
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return result.stdout.trim();
}

function sanitizeSegment(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(new RegExp(`[${escapeRegExp(sep)}]+`, 'g'), '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/-+/g, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

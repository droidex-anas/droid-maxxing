import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  createAutomationWorkspace,
  releaseAutomationWorkspace,
  resolveAutomationWorkspace,
} from './workspace.js';

const execFileAsync = promisify(execFile);

test('release removes a clean linked worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-workspace-'));
  const repository = join(directory, 'repository');

  try {
    await initializeRepository(repository);
    const input = {
      cwd: repository,
      executionMode: 'worktree' as const,
      title: 'Clean worktree',
      runId: 'run-123456',
    };
    const target = await resolveAutomationWorkspace(input);
    await createAutomationWorkspace(input, target);
    assert.equal(existsSync(target), true);

    await releaseAutomationWorkspace({ resolvedCwd: target, executionMode: 'worktree' });
    assert.equal(existsSync(target), false);
    assert.doesNotMatch(await git(repository, ['worktree', 'list', '--porcelain']), /run-123456/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preserves a main worktree with a separate Git directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-workspace-'));
  const repository = join(directory, 'repository');
  const gitDirectory = join(directory, 'repository.git');

  try {
    await mkdir(directory, { recursive: true });
    await git(directory, ['init', `--separate-git-dir=${gitDirectory}`, repository]);
    await releaseAutomationWorkspace({ resolvedCwd: repository, executionMode: 'worktree' });
    assert.equal(existsSync(repository), true);
    assert.equal(existsSync(gitDirectory), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preserves a submodule working tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-workspace-'));
  const parent = join(directory, 'parent');
  const child = join(directory, 'child');
  const submodule = join(parent, 'modules', 'child');

  try {
    await initializeRepository(parent);
    await initializeRepository(child);
    await git(parent, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      child,
      'modules/child',
    ]);

    await releaseAutomationWorkspace({ resolvedCwd: submodule, executionMode: 'worktree' });
    assert.equal(existsSync(submodule), true);
    assert.equal(await git(submodule, ['rev-parse', '--show-toplevel']), await realpath(submodule));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preserves a clean linked worktree outside the automation layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-workspace-'));
  const repository = join(directory, 'repository');
  const unrelated = join(directory, 'unrelated');

  try {
    await initializeRepository(repository);
    await git(repository, ['worktree', 'add', '--detach', unrelated, 'HEAD']);

    await releaseAutomationWorkspace({ resolvedCwd: unrelated, executionMode: 'worktree' });

    assert.equal(existsSync(unrelated), true);
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /unrelated/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function initializeRepository(repository: string): Promise<void> {
  await git(tmpdir(), ['init', repository]);
  const empty = join(repository, 'empty');
  await writeFile(empty, '');
  const tree = await git(repository, ['hash-object', '-t', 'tree', '-w', empty]);
  const commitFile = join(repository, 'commit');
  await writeFile(
    commitFile,
    [
      `tree ${tree}`,
      'author Test Fixture <fixture@example.invalid> 0 +0000',
      'committer Test Fixture <fixture@example.invalid> 0 +0000',
      '',
      'fixture',
      '',
    ].join('\n'),
  );
  const commit = await git(repository, ['hash-object', '-t', 'commit', '-w', commitFile]);
  await git(repository, ['update-ref', 'HEAD', commit]);
  await rm(empty);
  await rm(commitFile);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

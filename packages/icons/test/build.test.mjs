import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('rebuilding removes retired JS, declarations and SVGs from the package', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'droidex-icon-build-'));
  const root = new URL('../', import.meta.url);
  const target = join(workspace, 'packages/icons');
  try {
    await mkdir(target, { recursive: true });
    for (const path of ['src', 'tools', 'package.json', 'tsconfig.json']) {
      await cp(new URL(path, root), join(target, path), { recursive: true });
    }
    await copyFile(new URL('../../LICENSE', root), join(workspace, 'LICENSE'));
    await symlink(
      fileURLToPath(new URL('../../node_modules', root)),
      join(workspace, 'node_modules'),
      'dir',
    );
    for (const directory of ['dist', 'svg']) {
      await mkdir(join(target, directory));
    }
    for (const path of ['dist/retired.js', 'dist/retired.d.ts', 'svg/retired.svg']) {
      await writeFile(join(target, path), 'retired build output\n');
    }

    await promisify(execFile)('npm', ['run', 'build'], { cwd: target });

    const modules = await readdir(join(target, 'dist'));
    assert.ok(!modules.includes('retired.js'));
    assert.ok(!modules.includes('retired.d.ts'));
    assert.ok(modules.includes('index.js'));
    assert.ok(modules.includes('index.d.ts'));
    assert.ok(modules.includes('styles.css'));
    const svgFiles = await readdir(join(target, 'svg'));
    assert.ok(!svgFiles.includes('retired.svg'));
    assert.deepEqual(svgFiles.sort(), (await readdir(new URL('svg/', root))).sort());
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

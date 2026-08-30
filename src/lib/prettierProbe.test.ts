import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import * as prettier from 'prettier';

const FILES = [
  'src/lib/nativeBrowserAgentSemantic.test.ts',
  'src/lib/nativeBrowserSemanticState.test.ts',
  'src/lib/nativeBrowserSemanticTracker.ts',
];

test('print exact Prettier patch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-prettier-'));
  try {
    const patches: string[] = [];

    for (const file of FILES) {
      const source = await readFile(file, 'utf8');
      const config = (await prettier.resolveConfig(file)) ?? {};
      const formatted = await prettier.format(source, {
        ...config,
        filepath: file,
      });
      const target = join(directory, basename(file));
      await writeFile(target, formatted, 'utf8');

      const result = spawnSync('diff', ['-u', '--label', file, file, '--label', file, target], {
        encoding: 'utf8',
      });

      if (result.stdout) patches.push(result.stdout);
    }

    console.log(`PRETTIER_PATCH_START\n${patches.join('\n')}PRETTIER_PATCH_END`);
    assert.fail('temporary Prettier probe');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

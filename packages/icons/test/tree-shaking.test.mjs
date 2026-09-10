import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

for (const entry of ['../src/index.ts', '../dist/index.js']) {
  test(`a single icon import excludes unused glyphs from ${entry}`, async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'icon-consumer',
          resolveId(id) {
            if (id === 'icon-consumer') return '\0icon-consumer';
          },
          load(id) {
            if (id === '\0icon-consumer') {
              return `export { Spinner } from ${JSON.stringify(fileURLToPath(new URL(entry, import.meta.url)))};`;
            }
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: 'icon-consumer',
          preserveEntrySignatures: 'strict',
          external: [/^react(?:\/|$)/],
          output: { format: 'es' },
        },
      },
    });
    const chunks = result.output.filter((chunk) => chunk.type === 'chunk');
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].exports, ['Spinner']);
    const bytes = Buffer.byteLength(chunks[0].code);
    assert.ok(bytes < 2_000, `Single-icon bundle grew to ${bytes} bytes without React`);
  });
}

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';

// Every byte of this bundle is parsed and compiled into two resident worker
// isolates. A single value import of @factory/droid-sdk from the history graph
// previously dragged the SDK, ws, ajv, zod, hono, and the MCP SDK into both,
// costing ~83 MiB of sidecar RSS for code the workers never call.
const MAX_BUNDLE_BYTES = 200_000;

async function bundleHistoryWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./historyPersistenceWorker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'historyPersistenceWorker.mjs',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const output = Object.values(result.metafile.outputs)[0];
  if (!output) throw new Error('esbuild produced no history worker output.');
  return { inputs: Object.keys(output.inputs), bytes: output.bytes };
}

test('history worker bundle pulls in no third-party runtime', async () => {
  const { inputs } = await bundleHistoryWorker();
  const thirdParty = inputs.filter((path) => path.includes('node_modules'));
  assert.deepEqual(
    thirdParty,
    [],
    `History worker must stay dependency-free; found ${thirdParty.join(', ')}`,
  );
});

test('history worker bundle stays within its size budget', async () => {
  const { bytes } = await bundleHistoryWorker();
  assert.ok(
    bytes <= MAX_BUNDLE_BYTES,
    `History worker bundle is ${String(bytes)} bytes, budget ${String(MAX_BUNDLE_BYTES)}`,
  );
});

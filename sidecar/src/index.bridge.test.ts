import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const INDEX_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
  'utf8',
);

test('sidecar shutdown shares one trigger across signals and stdin close', () => {
  assert.match(INDEX_SOURCE, /createSharedShutdown/);
  assert.match(INDEX_SOURCE, /process\.on\('SIGINT', \(\) => void shutdown\(\)\)/);
  assert.match(INDEX_SOURCE, /process\.on\('SIGTERM', \(\) => void shutdown\(\)\)/);
  assert.match(INDEX_SOURCE, /process\.stdin\.once\('end', \(\) => void shutdown\(\)\)/);
  assert.match(INDEX_SOURCE, /process\.stdin\.once\('close', \(\) => void shutdown\(\)\)/);
  assert.equal(INDEX_SOURCE.includes('setTimeout(() => process.exit(1), 5_000)'), false);
  assert.match(INDEX_SOURCE, /deadline\.remainingMs\(\)/);
  assert.match(INDEX_SOURCE, /manager\.shutdown\(deadline\)/);
  assert.match(INDEX_SOURCE, /server\.close\(deadline\)/);
});

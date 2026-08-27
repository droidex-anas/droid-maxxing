import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HistoryPersistenceQueue } from './HistoryPersistenceQueue.js';
import type { HistoryPersistenceCall, HistoryPersistenceClient } from './HistoryWorkerClient.js';
import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
} from './historyPersistenceProtocol.js';

function acceptedCall(): HistoryPersistenceCall<{ accepted: true }> {
  const value = { accepted: true } as const;
  return {
    promise: Promise.resolve(value),
    waitSync: () => value,
  };
}

class TrackingClient implements HistoryPersistenceClient {
  warmCalls = 0;
  persistCalls = 0;

  warm(): HistoryPersistenceCall<{ accepted: true }> {
    this.warmCalls += 1;
    return acceptedCall();
  }

  startPersist(batch: HistoryPersistenceBatch): HistoryPersistenceCall<HistoryPersistenceResult> {
    this.persistCalls += 1;
    const result: HistoryPersistenceResult = {
      durationMs: 1,
      eventsWritten: batch.events.length,
      summariesWritten: batch.summaries.length,
      childrenWritten: batch.children.length,
    };
    return {
      promise: Promise.resolve(result),
      waitSync: () => result,
    };
  }

  startDurabilityBarrier(): HistoryPersistenceCall<{ durable: true }> {
    const value = { durable: true } as const;
    return {
      promise: Promise.resolve(value),
      waitSync: () => value,
    };
  }

  closeSync(): void {
    // no-op
  }
}

test('history persistence queue does not spawn its worker until warm or persist', () => {
  const client = new TrackingClient();
  const queue = new HistoryPersistenceQueue({
    dbPath: join(mkdtempSync(join(tmpdir(), 'droid-queue-')), 'history.db'),
    client,
  });
  assert.equal(client.warmCalls, 0);
  assert.equal(client.persistCalls, 0);
  queue.warm();
  assert.equal(client.warmCalls, 1);
  assert.equal(client.persistCalls, 0);
});

test('SIDECAR_READY is emitted before optional persistence warm finishes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droid-sidecar-boot-'));
  const token = 'a'.repeat(64);
  const assetToken = 'b'.repeat(64);
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const start = performance.now();
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_TOKEN: token,
      BROWSER_ASSET_TOKEN: assetToken,
      BRIDGE_PORT: '0',
      DROIDEX_USER_DATA_DIR: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  const readyMs = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for SIDECAR_READY')),
      20_000,
    );
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/SIDECAR_READY (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(performance.now() - start);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!stdout.includes('SIDECAR_READY')) {
        reject(new Error(`sidecar exited before ready (${String(code)}): ${stdout}`));
      }
    });
  });

  assert.ok(readyMs < 5_000, `expected fast readiness, got ${readyMs.toFixed(1)}ms`);
  child.kill();
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PersistenceDirtyMarker, persistenceDirtyMarkerPath } from './persistenceDirtyMarker.js';

test('a dirty marker from a dead process is reported as unflushed work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dirty-marker-'));
  try {
    const path = persistenceDirtyMarkerPath(dir);
    const previous = new PersistenceDirtyMarker(path, 4242, () => false);
    previous.markDirty();
    const recovered = new PersistenceDirtyMarker(path, 99, () => false);
    const recovery = recovered.recovery();
    assert.equal(recovery.durable, false);
    assert.equal(recovery.hadUnflushedWork, true);
    assert.match(recovery.message ?? '', /unflushed history/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing the marker does not present unflushed work as durable loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dirty-marker-clean-'));
  try {
    const path = persistenceDirtyMarkerPath(dir);
    const marker = new PersistenceDirtyMarker(path, 7, () => false);
    marker.markDirty();
    marker.markClean();
    const recovered = new PersistenceDirtyMarker(path, 8, () => false);
    assert.deepEqual(recovered.recovery(), { durable: true, hadUnflushedWork: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

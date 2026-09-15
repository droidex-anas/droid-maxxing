import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachRecentCapture,
  bindCaptureDestination,
  createCaptureGeneration,
  openComposerCapture,
} from './composerDestination';

test('a stale capture cannot become current again after leaving and returning to a chat', () => {
  const lease = createCaptureGeneration();
  const old = lease.stamp();
  lease.invalidate();
  lease.invalidate();
  assert.equal(lease.isCurrent(old), false);
  assert.equal(lease.isCurrent(lease.stamp()), true);
});
test('an unmounted old composer cannot unbind its newer replacement', async () => {
  const seen: string[] = [];
  const old = bindCaptureDestination({
    open: () => seen.push('old-open'),
    attach: async (id) => {
      seen.push(`old-${id}`);
    },
  });
  const current = bindCaptureDestination({
    open: () => seen.push('current-open'),
    attach: async (id) => {
      seen.push(`current-${id}`);
    },
  });
  old();
  openComposerCapture();
  await attachRecentCapture('one');
  assert.deepEqual(seen, ['current-open', 'current-one']);
  current();
  assert.throws(openComposerCapture, /Open a chat/);
  await assert.rejects(attachRecentCapture('two'), /Open a chat/);
});

test('desktop and composer entry points stay distinct when routed to the active draft', () => {
  const seen: unknown[] = [];
  const release = bindCaptureDestination({
    open: (origin) => {
      seen.push(origin);
    },
    attach: async () => {},
  });
  try {
    openComposerCapture('desktop');
    openComposerCapture();
    assert.deepEqual(seen, ['desktop', 'composer']);
  } finally {
    release();
  }
});

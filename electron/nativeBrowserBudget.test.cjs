const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNativeBrowserBudget,
  restoreScrollScript,
  CAPTURE_SCROLL_SCRIPT,
} = require('./nativeBrowserBudget.cjs');

function entry(id, overrides = {}) {
  return {
    browserSessionId: id,
    attached: false,
    hasView: true,
    lastUsedAt: 0,
    targetUrl: `https://example.test/${id}`,
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    state: { designMode: false, pencilMode: false },
    serialized: null,
    ...overrides,
  };
}

test('visible session plus one warm hidden view stay live; older hidden views evict', () => {
  const budget = createNativeBrowserBudget({ maxLive: 2, now: () => 1000 });
  const ids = budget.idsToEvict([
    entry('attached', { attached: true, lastUsedAt: 900 }),
    entry('warm', { lastUsedAt: 800 }),
    entry('cold-a', { lastUsedAt: 100 }),
    entry('cold-b', { lastUsedAt: 50 }),
  ]);
  assert.deepEqual(ids.sort(), ['cold-a', 'cold-b']);
});

test('with no attached view only the most recently used hidden session stays warm', () => {
  const budget = createNativeBrowserBudget({ maxLive: 2, now: () => 1000 });
  const ids = budget.idsToEvict([
    entry('older', { lastUsedAt: 10 }),
    entry('newest', { lastUsedAt: 50 }),
    entry('middle', { lastUsedAt: 20 }),
  ]);
  assert.deepEqual(ids.sort(), ['middle', 'older']);
  assert.equal(
    budget.warmHiddenId([entry('older', { lastUsedAt: 10 }), entry('newest', { lastUsedAt: 50 })]),
    'newest',
  );
});

test('idle eviction is disabled when idleMs is 0 and enabled after the timeout', () => {
  let now = 0;
  const budget = createNativeBrowserBudget({ idleMs: 0, now: () => now });
  assert.equal(budget.shouldIdleEvict(entry('warm', { lastUsedAt: 0 })), false);

  const timed = createNativeBrowserBudget({ idleMs: 5_000, now: () => now });
  now = 4_999;
  assert.equal(timed.shouldIdleEvict(entry('warm', { lastUsedAt: 0 })), false);
  now = 5_000;
  assert.equal(timed.shouldIdleEvict(entry('warm', { lastUsedAt: 0 })), true);
  assert.equal(timed.shouldIdleEvict(entry('attached', { attached: true, lastUsedAt: 0 })), false);
});

test('counts report live, warm, attached, and serialized sessions', () => {
  const budget = createNativeBrowserBudget({ maxLive: 2, now: () => 1 });
  const counts = budget.counts([
    entry('attached', { attached: true, lastUsedAt: 3 }),
    entry('warm', { lastUsedAt: 2 }),
    entry('serialized', { hasView: false, serialized: { url: 'https://example.test' } }),
  ]);
  assert.deepEqual(counts, {
    total: 3,
    live: 2,
    attached: 1,
    warm: 1,
    serialized: 1,
    maxLive: 2,
    idleMs: 0,
  });
});

test('snapshot preserves url, scroll, viewport, and design metadata', () => {
  const budget = createNativeBrowserBudget({ now: () => 42 });
  const snapshot = budget.snapshotFrom(
    entry('a', { state: { designMode: true, pencilMode: true } }),
    {
      url: 'https://app.example/path',
      scroll: { x: 12, y: 340 },
      screenshot: 'png-bytes',
    },
  );
  assert.deepEqual(snapshot, {
    url: 'https://app.example/path',
    scroll: { x: 12, y: 340 },
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    state: { designMode: true, pencilMode: true },
    screenshot: 'png-bytes',
    evictedAt: 42,
  });
});

test('restore script and capture script stay numeric and eviction is distinct from a crash', () => {
  const budget = createNativeBrowserBudget();
  assert.equal(budget.isEvictionClose('evict'), true);
  assert.equal(budget.isEvictionClose('crash'), false);
  assert.match(CAPTURE_SCROLL_SCRIPT, /scrollX/);
  assert.equal(restoreScrollScript({ x: 10.9, y: 20.2 }), restoreScrollScript({ x: 11, y: 20 }));
  assert.match(restoreScrollScript({ x: 3, y: 7 }), /scrollTo\(3,7\)/);
});

test('a multi-hour-equivalent hidden-browser workload plateaus at maxLive views', () => {
  let now = 0;
  const budget = createNativeBrowserBudget({ maxLive: 2, idleMs: 0, now: () => now });
  const browsers = Array.from({ length: 12 }, (_, index) =>
    entry(`b${String(index)}`, {
      attached: index === 11,
      lastUsedAt: index,
    }),
  );
  const evicted = new Set(budget.idsToEvict(browsers));
  for (const item of browsers) {
    if (!evicted.has(item.browserSessionId)) continue;
    item.hasView = false;
    item.serialized = { url: item.targetUrl };
  }
  now = 6 * 60 * 60 * 1000;
  const later = budget.counts(browsers);
  assert.equal(later.live, 2);
  assert.equal(later.serialized, 10);
  assert.deepEqual(budget.idsToEvict(browsers), []);
});

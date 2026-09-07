import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCropMutations,
  createPendingAdditions,
  insertBySequence,
  itemsBeforeCutoff,
  pathsInSequence,
  saveImageUnlessStale,
  type AttachedImage,
} from './useImageAttachments';

const img = (id: string): AttachedImage => ({
  id,
  path: `/tmp/${id}.png`,
  preview: `data:${id}`,
  sequence: 0,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('insertBySequence keeps paste order when encodes finish out of order', () => {
  // Pasted a, b, c in that order; the variably slow encodes finish c, a, b.
  const sequences = new Map([
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
  let images: AttachedImage[] = [];
  images = insertBySequence(images, img('c'), sequences);
  images = insertBySequence(images, img('a'), sequences);
  images = insertBySequence(images, img('b'), sequences);
  assert.deepEqual(
    images.map((i) => i.id),
    ['a', 'b', 'c'],
  );
});

test('insertBySequence sorts images without a reserved sequence last', () => {
  const sequences = new Map([['a', 0]]);
  const images = insertBySequence([img('a')], img('late'), sequences);
  assert.deepEqual(
    images.map((i) => i.id),
    ['a', 'late'],
  );
});

test('insertBySequence does not mutate the existing list', () => {
  const before = [img('a')];
  const sequences = new Map([
    ['a', 0],
    ['b', 1],
  ]);
  insertBySequence(before, img('b'), sequences);
  assert.deepEqual(
    before.map((i) => i.id),
    ['a'],
  );
});

test('settled waits for in-flight additions', async () => {
  const additions = createPendingAdditions();
  const add = deferred();
  additions.track(add.promise);
  let settled = false;
  const waiting = additions.settled().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  add.resolve();
  await waiting;
  assert.equal(settled, true);
});

test('settled keeps waiting when an addition starts mid-wait', async () => {
  // Regression for the submit race: a paste that begins while runSubmit is
  // already awaiting still has to land before the snapshot is taken.
  const additions = createPendingAdditions();
  const first = deferred();
  const second = deferred();
  additions.track(first.promise);
  let settled = false;
  const waiting = additions.settled().then(() => {
    settled = true;
  });
  additions.track(second.promise);
  first.resolve();
  await tick();
  assert.equal(settled, false);
  second.resolve();
  await waiting;
  assert.equal(settled, true);
});

test('knownSettled ignores additions that start after the snapshot', async () => {
  const additions = createPendingAdditions();
  const first = deferred();
  const second = deferred();
  additions.track(first.promise);
  const waiting = additions.knownSettled();
  additions.track(second.promise);
  first.resolve();
  await waiting;
  second.resolve();
});

test('submit waits for a crop that starts while an addition is still encoding', async () => {
  const additions = createPendingAdditions();
  const crops = createCropMutations();
  const add = deferred();
  const crop = deferred();
  additions.track(add.promise);
  let ready = false;
  const waiting = (async () => {
    await additions.knownSettled();
    await crops.waitBeforeCutoff(1);
    ready = true;
  })();
  crops.track(0, crop.promise);
  add.resolve();
  await tick();
  assert.equal(ready, false);
  crop.resolve();
  await waiting;
  assert.equal(ready, true);
});

test('submit does not wait for a crop of an attachment past cutoff', async () => {
  const crops = createCropMutations();
  const crop = deferred();
  crops.track(1, crop.promise);
  await crops.waitBeforeCutoff(1);
  crop.resolve();
});

test('itemsBeforeCutoff keeps only attachments reserved before submit', () => {
  const sequences = new Map([
    ['a', 0],
    ['b', 1],
    ['late', 2],
  ]);
  assert.deepEqual(
    itemsBeforeCutoff([img('a'), img('b'), img('late')], sequences, 2).map((item) => item.id),
    ['a', 'b'],
  );
});

test('pathsInSequence merges mixed attachment types by intake order', () => {
  assert.deepEqual(
    pathsInSequence([
      { path: '/tmp/notes.pdf', sequence: 1 },
      { path: '/tmp/shot.png', sequence: 0 },
    ]),
    ['/tmp/shot.png', '/tmp/notes.pdf'],
  );
});

test('invalidate marks earlier additions stale, not later ones', () => {
  const additions = createPendingAdditions();
  const beforeClear = additions.stamp();
  additions.invalidate();
  const afterClear = additions.stamp();
  assert.equal(additions.isStale(beforeClear), true);
  assert.equal(additions.isStale(afterClear), false);
});

test('saveImageUnlessStale deletes the fresh file when a clear landed mid-save', async () => {
  // Regression for the addBlob/applyCrop submit races: a clear() while the
  // file is still being written must delete it on landing instead of letting
  // it surface (as a chip or an orphaned temp file) on a later prompt.
  const additions = createPendingAdditions();
  const stamp = additions.stamp();
  const write = deferred();
  const discarded: string[] = [];
  const saving = saveImageUnlessStale(
    additions,
    stamp,
    async () => {
      await write.promise;
      return '/tmp/fresh.png';
    },
    async (path) => {
      discarded.push(path);
    },
  );
  additions.invalidate(); // clear() while the file is being written
  write.resolve();
  assert.equal(await saving, null);
  assert.deepEqual(discarded, ['/tmp/fresh.png']);
});

test('saveImageUnlessStale keeps the saved path when no clear landed', async () => {
  const additions = createPendingAdditions();
  const stamp = additions.stamp();
  const discarded: string[] = [];
  const path = await saveImageUnlessStale(
    additions,
    stamp,
    () => Promise.resolve('/tmp/fresh.png'),
    async (p) => {
      discarded.push(p);
    },
  );
  assert.equal(path, '/tmp/fresh.png');
  assert.deepEqual(discarded, []);
});

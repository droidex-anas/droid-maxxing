import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewPreviewRequest } from './reviewPreview';
import type { FilePreviewPayload } from './desktop';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve(value: T) {
      assert.ok(resolve);
      resolve(value);
    },
    reject(error: Error) {
      assert.ok(reject);
      reject(error);
    },
  };
}

function textPreview(text: string): FilePreviewPayload {
  return {
    category: 'text',
    totalSize: text.length,
    sizeCapBytes: 100,
    previewable: true,
    text,
    path: { root: '/repo', relative: 'file.ts' },
  };
}

for (const action of ['Close', 'jumpTo']) {
  test(`${action} synchronously cancels a detached preview before its read settles`, async () => {
    const read = deferred<FilePreviewPayload>();
    const started = deferred<void>();
    const results: unknown[] = [];
    const request = createReviewPreviewRequest({
      authorizeRoot: async () => 'workspace-token',
      readPreview: async () => {
        started.resolve();
        return read.promise;
      },
    });
    const pending = request.load('/repo', 'file.ts', (result) => results.push(result));
    await started.promise;
    request.cancel(); // Both handlers invalidate synchronously before clearing React state.
    read.resolve(textPreview('late content'));
    await pending;
    assert.deepEqual(results, []);
  });
}

test('cancelled authorization never starts a read and stale errors never surface', async () => {
  const access = deferred<string>();
  let reads = 0;
  const results: unknown[] = [];
  const request = createReviewPreviewRequest({
    authorizeRoot: () => access.promise,
    readPreview: async () => {
      reads += 1;
      return textPreview('content');
    },
  });
  const pending = request.load('/repo', 'file.ts', (result) => results.push(result));
  request.cancel();
  access.reject(new Error('late denial'));
  await pending;
  assert.equal(reads, 0);
  assert.deepEqual(results, []);
});

test('a replacement preview wins over an earlier deferred read', async () => {
  const first = deferred<FilePreviewPayload>();
  const started = deferred<void>();
  const results: unknown[] = [];
  const request = createReviewPreviewRequest({
    authorizeRoot: async () => 'workspace-token',
    readPreview: async (_token, path) => {
      if (path === 'first.ts') {
        started.resolve();
        return first.promise;
      }
      return textPreview('second');
    },
  });
  const pending = request.load('/repo', 'first.ts', (result) => results.push(result));
  await started.promise;
  await request.load('/repo', 'second.ts', (result) => results.push(result));
  first.resolve(textPreview('first'));
  await pending;
  assert.deepEqual(results, [{ content: 'second' }]);
});

test('preview failures surface and external paths never request Files access', async () => {
  let authorizations = 0;
  const results: unknown[] = [];
  const request = createReviewPreviewRequest({
    authorizeRoot: async () => {
      authorizations += 1;
      return 'workspace-token';
    },
    readPreview: async () => {
      throw new Error('symlink escapes root');
    },
  });
  await request.load('/repo', '/outside/file.ts', (result) => results.push(result));
  assert.equal(authorizations, 0);
  await request.load('/repo', 'file.ts', (result) => results.push(result));
  assert.deepEqual(results, [
    { error: 'File preview path is outside the workspace.' },
    { error: 'symlink escapes root' },
  ]);
});

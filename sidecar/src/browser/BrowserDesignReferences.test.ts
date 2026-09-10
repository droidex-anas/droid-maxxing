import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserDesignReferences } from './BrowserDesignReferences.js';
import type { BrowserRuntime } from './BrowserSessionManager.js';
import type { BrowserState, DesignAnchor } from './types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function runtimeWithCapture(capture: BrowserRuntime['capture']): BrowserRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected browser runtime call.');
  };
  return {
    open: unused,
    reload: unused,
    goBack: unused,
    goForward: unused,
    setViewport: unused,
    screenshot: unused,
    capture,
    snapshot: unused,
    click: unused,
    hover: unused,
    selectOption: unused,
    type: unused,
    keypress: unused,
    scroll: unused,
    inspect: unused,
    network: unused,
    console: unused,
    close: async () => undefined,
  };
}

function browserState(url: string): BrowserState {
  return {
    appSessionId: 'app-one',
    browserSessionId: 'browser-one',
    url,
    title: 'Example',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    viewportMode: 'fit',
    scroll: { x: 0, y: 0 },
    refs: [],
  };
}

function anchor(): DesignAnchor {
  return {
    id: '@button',
    kind: 'element',
    label: 'Save',
    box: { x: 10, y: 20, width: 80, height: 30 },
  };
}

async function withReferences(
  capture: BrowserRuntime['capture'],
  run: (references: BrowserDesignReferences, browserDataDir: string) => Promise<void>,
): Promise<void> {
  const browserDataDir = mkdtempSync(join(tmpdir(), 'droid-design-references-'));
  const references = new BrowserDesignReferences({
    appSessionId: 'app-one',
    browserSessionId: 'browser-one',
    browserDataDir,
    runtime: runtimeWithCapture(capture),
  });
  try {
    await run(references, browserDataDir);
  } finally {
    await rm(browserDataDir, { recursive: true, force: true });
  }
}

test('navigation during an anchor capture rejects and removes the stale crop', async () => {
  const captureStarted = deferred<void>();
  const finishCapture = deferred<string>();
  await withReferences(
    async () => {
      captureStarted.resolve();
      return finishCapture.promise;
    },
    async (references, browserDataDir) => {
      await references.navigate('https://example.com/first');
      const pending = references.add(browserState('https://example.com/first'), {
        anchor: anchor(),
      });
      await captureStarted.promise;
      await references.navigate('https://example.com/second');
      finishCapture.resolve(Buffer.from('crop').toString('base64'));

      await assert.rejects(pending, /page changed/i);
      assert.deepEqual(references.all(), []);
      assert.deepEqual(await readdir(join(browserDataDir, 'design-references', 'app-one')), []);
    },
  );
});

test('session disposal during an anchor capture rejects and removes the late crop', async () => {
  const captureStarted = deferred<void>();
  const finishCapture = deferred<string>();
  await withReferences(
    async () => {
      captureStarted.resolve();
      return finishCapture.promise;
    },
    async (references, browserDataDir) => {
      const pending = references.add(browserState('https://example.com'), { anchor: anchor() });
      await captureStarted.promise;
      await references.dispose();
      finishCapture.resolve(Buffer.from('crop').toString('base64'));

      await assert.rejects(pending, /session closed/i);
      assert.deepEqual(references.all(), []);
      assert.deepEqual(await readdir(join(browserDataDir, 'design-references', 'app-one')), []);
    },
  );
});

test('standalone screenshots keep only the newest 32 pending image files', async () => {
  await withReferences(
    async () => '',
    async (references, browserDataDir) => {
      let oldestPath = '';
      let newestPath = '';
      for (let index = 0; index < 33; index += 1) {
        const path = await references.saveImage(
          `screenshot-${index}.png`,
          Buffer.from(`screenshot-${index}`).toString('base64'),
        );
        if (index === 0) oldestPath = path;
        newestPath = path;
      }

      await assert.rejects(readFile(oldestPath), /ENOENT/);
      assert.equal((await readFile(newestPath, 'utf8')).length > 0, true);
      assert.equal(
        (await readdir(join(browserDataDir, 'design-references', 'app-one'))).length,
        32,
      );
    },
  );
});

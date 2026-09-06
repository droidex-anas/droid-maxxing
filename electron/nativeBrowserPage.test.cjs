const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserPage } = require('./nativeBrowserPage.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function image(base64 = 'captured') {
  return {
    isEmpty: () => false,
    toPNG: () => Buffer.from(base64),
  };
}

function harness(overrides = {}) {
  const commands = [];
  const idleCaptureCounts = [];
  const contents = {
    isDestroyed: () => false,
    setBackgroundThrottling() {},
    executeJavaScript: async (script) =>
      script.includes('__DROIDMAXX_MASK_SENSITIVE_FIELDS') ? true : undefined,
    capturePage: async () => image(),
    ...overrides.contents,
  };
  const view = {
    webContents: contents,
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  };
  const entry = {
    browserSessionId: 'browser-1',
    view,
    state: { designMode: false, pencilMode: false },
    attached: false,
    visible: true,
    documentGeneration: 1,
    captureActivityCount: 0,
  };
  const page = createNativeBrowserPage({
    appName: 'DROIDEX',
    ensureEntry: () => entry,
    restoreForAction: async () => entry,
    safeWebContents: (candidate) => candidate?.webContents ?? null,
    runWithWebContentsDebugger: async (_contents, operation) =>
      operation({
        sendCommand: async (name, params) => {
          commands.push({ name, params });
          if (name === 'Page.getLayoutMetrics') {
            return (
              overrides.metrics ?? {
                cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 800 },
                cssContentSize: { width: 1200, height: 800 },
              }
            );
          }
          return { data: 'cdp-image' };
        },
      }),
    scheduleIdleClose: (candidate) => idleCaptureCounts.push(candidate.captureActivityCount),
    findEntryForContents: (candidate) => (candidate === contents ? entry : undefined),
  });
  return { commands, contents, entry, idleCaptureCounts, page, view };
}

test('full-page capture rejects oversized output before requesting a screenshot', async () => {
  const { commands, page } = harness({
    metrics: {
      cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 800 },
      cssContentSize: { width: 20_000, height: 20_000 },
    },
  });

  await assert.rejects(
    page.capture('browser-1', undefined, { fullPage: true, deviceScaleFactor: 4 }),
    /too large.*viewport or region/i,
  );
  assert.deepEqual(
    commands.map(({ name }) => name),
    ['Page.getLayoutMetrics'],
  );
});

test('capture returns no image when the page does not acknowledge sensitive-field masking', async () => {
  let captureCount = 0;
  const { entry, page } = harness({
    contents: {
      executeJavaScript: async () => undefined,
      capturePage: async () => {
        captureCount += 1;
        return image();
      },
    },
  });

  await assert.rejects(
    page.capture('browser-1', { x: 0, y: 0, width: 100, height: 100 }),
    /sensitive fields could not be masked.*no screenshot/i,
  );
  assert.equal(captureCount, 0);
  assert.equal(entry.captureActivityCount, 0);
});

test('an overlapping capture is rejected before it can share the sensitive-field mask', async () => {
  const firstMask = deferred();
  const maskStarted = deferred();
  let maskActivationCount = 0;
  const { contents, entry, page } = harness({
    contents: {
      executeJavaScript: async (script) => {
        if (!script.includes('(true)')) return true;
        maskActivationCount += 1;
        if (maskActivationCount === 1) {
          maskStarted.resolve();
          return firstMask.promise;
        }
        return true;
      },
    },
  });

  const designCapture = page.captureDesignSelection(contents, {
    anchor: { box: { x: 10, y: 20, width: 100, height: 80 } },
  });
  await maskStarted.promise;

  const overlap = await page.capture('browser-1', { x: 0, y: 0, width: 100, height: 100 }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  firstMask.resolve(true);
  await designCapture;

  assert.equal(overlap.ok, false);
  assert.match(overlap.error.message, /screenshot capture is already in progress/i);
  assert.equal(maskActivationCount, 1);
  assert.equal(entry.captureActivityCount, 0);
});

test('design capture schedules idle enforcement after releasing capture activity', async () => {
  const { contents, idleCaptureCounts, page } = harness();

  await page.captureDesignSelection(contents, {
    anchor: { box: { x: 10, y: 20, width: 100, height: 80 } },
  });

  assert.deepEqual(idleCaptureCounts, [0]);
});

test('design capture stops when navigation replaces the document while masking', async () => {
  const masking = deferred();
  let captureCount = 0;
  const { contents, entry, page } = harness({
    contents: {
      executeJavaScript: () => masking.promise,
      capturePage: async () => {
        captureCount += 1;
        return image();
      },
    },
  });

  const capture = page.captureDesignSelection(contents, {
    anchor: { box: { x: 10, y: 20, width: 100, height: 80 } },
  });
  entry.documentGeneration += 1;
  masking.resolve(true);

  assert.equal(await capture, undefined);
  assert.equal(captureCount, 0);
  assert.equal(entry.captureActivityCount, 0);
});

test('design capture discards an image produced after the document changes', async () => {
  const captured = deferred();
  const { contents, entry, page } = harness({
    contents: {
      executeJavaScript: async () => true,
      capturePage: () => captured.promise,
    },
  });

  const capture = page.captureDesignSelection(contents, {
    anchor: { box: { x: 10, y: 20, width: 100, height: 80 } },
  });
  await Promise.resolve();
  entry.documentGeneration += 1;
  captured.resolve(image('wrong-document'));

  assert.equal(await capture, undefined);
  assert.equal(entry.captureActivityCount, 0);
});

test('capture rejects an image produced after the document changes', async () => {
  const captured = deferred();
  const { entry, page } = harness({
    contents: {
      executeJavaScript: async () => true,
      capturePage: () => captured.promise,
    },
  });

  const capture = page.capture('browser-1', { x: 0, y: 0, width: 100, height: 100 });
  await Promise.resolve();
  entry.documentGeneration += 1;
  captured.resolve(image('wrong-document'));

  await assert.rejects(capture, /page changed before the screenshot completed/i);
  assert.equal(entry.captureActivityCount, 0);
});

test('design mode disables pencil mode and applies the canonical state', async () => {
  const applied = [];
  const { entry, page } = harness({
    contents: {
      executeJavaScript: async (script) => applied.push(script),
    },
  });
  entry.attached = true;

  await page.setDesignMode('browser-1', true);
  await page.setPencilMode('browser-1', true);
  await page.setDesignMode('browser-1', false);

  assert.deepEqual(entry.state, { designMode: false, pencilMode: false });
  assert.match(applied.at(-1), /"designMode":false,"pencilMode":false/);
});

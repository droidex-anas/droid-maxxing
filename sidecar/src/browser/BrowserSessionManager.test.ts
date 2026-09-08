import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BrowserSessionManager,
  type BrowserRuntime,
  type BrowserScrollAction,
  type BrowserSessionManagerOptions,
} from './BrowserSessionManager.js';
import { BrowserDesignReferences } from './BrowserDesignReferences.js';
import { writeDesignPromptPack } from './designPromptPacks.js';
import type {
  BrowserBox,
  BrowserElementRef,
  BrowserScreenshotOptions,
  BrowserState,
  BrowserViewport,
  DesignAnchor,
  DesignAnchorDetail,
  ScrollDirection,
} from './types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'droid-browser-test-'));

function createManager(options: BrowserSessionManagerOptions = {}): BrowserSessionManager {
  return new BrowserSessionManager({
    browserDataDir: dataDir,
    runtimeFactory: (_id, viewport) => new FakeRuntime(viewport),
    ...options,
  });
}

class FakeRuntime implements BrowserRuntime {
  clicks: { x: number; y: number; selector?: string }[] = [];
  hovers: { x: number; y: number; selector?: string }[] = [];
  refs: BrowserElementRef[] = [buttonRef()];
  selections: { selector: string; value: string }[] = [];
  scrolls: {
    direction: ScrollDirection;
    pixels?: number;
    x?: number;
    y?: number;
    selector?: string;
    ref?: string;
  }[] = [];
  screenshots: BrowserScreenshotOptions[] = [];
  captures: (BrowserBox | undefined)[] = [];
  viewport: BrowserViewport;
  openedUrls: string[] = [];
  openedSources: Array<'agent' | 'user' | undefined> = [];
  reloads = 0;
  history: ('back' | 'forward')[] = [];
  canGoBack = false;
  canGoForward = false;
  omitHistory = false;
  snapshotRequests = 0;
  clickError?: Error;
  openError?: Error;
  viewportError?: Error;

  constructor(viewport: BrowserViewport) {
    this.viewport = viewport;
  }

  async open(url: string, source?: 'agent' | 'user') {
    this.openedUrls.push(url);
    this.openedSources.push(source);
    if (this.openError) throw this.openError;
    return this.stateSnapshot(url);
  }

  async reload() {
    this.reloads += 1;
    return this.stateSnapshot('https://example.com/reloaded');
  }

  async goBack() {
    this.history.push('back');
    return this.stateSnapshot('https://example.com/back');
  }

  async goForward() {
    this.history.push('forward');
    return this.stateSnapshot('https://example.com/forward');
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    if (this.viewportError) throw this.viewportError;
    this.viewport = viewport;
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<string> {
    this.screenshots.push(options);
    return Buffer.from('full-screenshot').toString('base64');
  }

  async capture(box?: BrowserBox): Promise<string> {
    this.captures.push(box);
    return Buffer.from('crop').toString('base64');
  }

  async snapshot(url = 'http://127.0.0.1:1420/') {
    this.snapshotRequests += 1;
    return this.stateSnapshot(url);
  }

  private stateSnapshot(url = 'http://127.0.0.1:1420/') {
    return {
      url,
      title: 'Droid Control',
      scroll: { x: 0, y: 0 },
      refs: this.refs,
      ...(this.omitHistory ? {} : { canGoBack: this.canGoBack, canGoForward: this.canGoForward }),
    };
  }

  async click(x: number, y: number, selector?: string) {
    this.clicks.push({ x, y, selector });
    if (this.clickError) throw this.clickError;
    return this.stateSnapshot();
  }

  async hover(x: number, y: number, selector?: string) {
    this.hovers.push({ x, y, selector });
    return this.stateSnapshot();
  }

  async selectOption(selector: string, value: string) {
    this.selections.push({ selector, value });
    return this.stateSnapshot();
  }
  async type() {
    return this.stateSnapshot();
  }
  async keypress() {
    return this.stateSnapshot();
  }
  async scroll(input: BrowserScrollAction) {
    this.scrolls.push(input);
    return {
      ...this.stateSnapshot(),
      scrollResult: {
        x: 0,
        y: input.direction === 'down' ? (input.pixels ?? 500) : 0,
        moved: true,
        atBoundary: false,
        requested: {
          x: 0,
          y: input.direction === 'down' ? (input.pixels ?? 500) : -(input.pixels ?? 500),
        },
      },
    };
  }
  async inspect(selector: string) {
    const ref = this.refs.find((item) => item.selector === selector);
    if (!ref) throw new Error('Element not found');
    return {
      selector,
      tagName: ref.tagName,
      role: ref.role,
      name: ref.name,
      text: ref.text,
      attributes: ref.attributes ?? {},
      box: ref.box,
      html: '<button>Save</button>',
    };
  }
  async network() {
    return [];
  }
  async console() {
    return [];
  }
  async close(): Promise<void> {}
}

test('runtime snapshots propagate navigation history state', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      runtime.canGoBack = true;
      return runtime;
    },
  });

  const opened = await manager.open({
    appSessionId: 'm1',
    url: 'http://127.0.0.1:1420/',
  });
  assert.equal(opened.canGoBack, true);
  assert.equal(opened.canGoForward, false);

  runtime.canGoForward = true;
  const reloaded = await manager.reload('m1');
  assert.equal(reloaded.canGoBack, true);
  assert.equal(reloaded.canGoForward, true);
});

test('a cold manager restores the persisted browser identity without navigating', async () => {
  let runtime!: FakeRuntime;
  const created: { browserSessionId: string; appSessionId: string }[] = [];
  const manager = createManager({
    runtimeFactory: (browserSessionId, viewport, appSessionId) => {
      created.push({ browserSessionId, appSessionId });
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });

  const restored = manager.restore({
    browserSessionId: 'browser-persisted',
    appSessionId: 'app-persisted',
    url: 'https://example.com/persisted',
    title: 'Persisted page',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    viewportMode: 'custom',
    scroll: { x: 4, y: 12 },
    canGoBack: true,
  });

  assert.deepEqual(created, [
    { browserSessionId: 'browser-persisted', appSessionId: 'app-persisted' },
  ]);
  assert.equal(restored.browserSessionId, 'browser-persisted');
  assert.equal(restored.url, 'https://example.com/persisted');
  assert.deepEqual(restored.refs, []);
  assert.deepEqual(runtime.openedUrls, []);
  assert.equal(runtime.snapshotRequests, 0);

  await manager.reload('app-persisted');
  assert.equal(runtime.reloads, 1);
});

test('restore keeps an existing session authoritative and never reopens its stale URL', async () => {
  let runtime!: FakeRuntime;
  let runtimeCount = 0;
  const manager = createManager({
    runtimeFactory: (_browserSessionId, viewport) => {
      runtimeCount += 1;
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  const live = await manager.open({
    appSessionId: 'app-live',
    url: 'https://example.com/live',
  });

  const restored = manager.restore({
    browserSessionId: 'browser-stale',
    appSessionId: 'app-live',
    url: 'https://example.com/stale',
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    viewportMode: 'mobile',
    scroll: { x: 0, y: 0 },
  });

  assert.equal(restored.browserSessionId, live.browserSessionId);
  assert.equal(restored.url, 'https://example.com/live');
  assert.deepEqual(runtime.openedUrls, ['https://example.com/live']);
  assert.equal(runtimeCount, 1);
  assert.equal(runtime.snapshotRequests, 0);
});

test('opening a new page clears stale history when its snapshot omits navigation state', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      runtime.canGoBack = true;
      runtime.canGoForward = true;
      return runtime;
    },
  });

  await manager.open({ appSessionId: 'm1', url: 'https://example.com/first' });
  runtime.omitHistory = true;
  const opened = await manager.open({ appSessionId: 'm1', url: 'https://example.com/second' });

  assert.equal(opened.canGoBack, false);
  assert.equal(opened.canGoForward, false);
});

test('click by ref uses the cached selector without a redundant pre-action snapshot', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });
  await manager.click({ appSessionId: 'm1', ref: '@e1' });

  assert.deepEqual(runtime.clicks[0], { x: 50, y: 35, selector: 'button' });
  assert.equal(runtime.snapshotRequests, 0);
});

test('click by missing ref fails without issuing a runtime action', async () => {
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  runtime.refs = [];
  const manager = createManager({
    runtimeFactory: () => runtime,
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await assert.rejects(
    manager.click({ appSessionId: 'm1', ref: '@e1' }),
    /Browser ref @e1 is not available/,
  );
  assert.deepEqual(runtime.clicks, []);
});

test('inspect resolves a current ref to its selector', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const inspection = await manager.inspect('m1', { ref: '@e1' });

  assert.equal(inspection.selector, 'button');
  assert.equal(inspection.html, '<button>Save</button>');
});

test('resize clears stale refs without requesting a snapshot', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const state = await manager.resizeViewport({
    appSessionId: 'm1',
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    viewportMode: 'mobile',
  });

  assert.deepEqual(state.refs, []);
  assert.equal(runtime.snapshotRequests, 0);
});

test('failed resize preserves the previous viewport and emits no optimistic update', async () => {
  const updates: BrowserState[] = [];
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  const manager = createManager({
    runtimeFactory: () => runtime,
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state);
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });
  const updateCount = updates.length;
  runtime.viewportError = new Error('resize failed');

  await assert.rejects(
    manager.resizeViewport({
      appSessionId: 'm1',
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      viewportMode: 'mobile',
    }),
    /resize failed/,
  );

  assert.equal(updates.length, updateCount);
  assert.deepEqual(manager.state('m1')?.viewport, {
    width: 1200,
    height: 800,
    deviceScaleFactor: 2,
  });
});

test('failed open preserves the committed URL and viewport without emitting optimistic state', async () => {
  const updates: BrowserState[] = [];
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  const manager = createManager({
    runtimeFactory: () => runtime,
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state);
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'https://example.com/committed' });
  const committed = manager.state('m1');
  const updateCount = updates.length;
  runtime.openError = new Error('load failed');

  await assert.rejects(
    manager.open({
      appSessionId: 'm1',
      url: 'https://example.com/failed',
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      viewportMode: 'mobile',
    }),
    /load failed/,
  );

  assert.equal(updates.length, updateCount);
  assert.equal(manager.state('m1')?.url, committed?.url);
  assert.deepEqual(manager.state('m1')?.viewport, committed?.viewport);
  assert.equal(manager.state('m1')?.viewportMode, committed?.viewportMode);
});

test('failed agent click does not emit speculative browser state', async () => {
  const updates: BrowserState[] = [];
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  const manager = createManager({
    runtimeFactory: () => runtime,
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state);
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });
  const updateCount = updates.length;
  runtime.clickError = new Error('click failed');

  await assert.rejects(manager.click({ appSessionId: 'm1', ref: '@e1' }), /click failed/);

  assert.equal(updates.length, updateCount);
});

test('hover and select target current snapshot refs', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await manager.hover({ appSessionId: 'm1', ref: '@e1' });
  await manager.selectOption('m1', '@e1', 'active');

  assert.deepEqual(runtime.hovers, [{ x: 50, y: 35, selector: 'button' }]);
  assert.deepEqual(runtime.selections, [{ selector: 'button', value: 'active' }]);
});

test('untargeted scroll defers its point to the live native viewport', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await manager.scroll('m1', 'down', 500);
  await manager.scroll('m1', 'up', 200, 'agent', '@e1');

  assert.deepEqual(runtime.scrolls, [
    {
      direction: 'down',
      pixels: 500,
      x: undefined,
      y: undefined,
      selector: undefined,
      ref: undefined,
    },
    { direction: 'up', pixels: 200, x: 50, y: 35, selector: 'button', ref: '@e1' },
  ]);
});

test('scroll movement is cleared by the next non-scroll browser snapshot', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const scrolled = await manager.scroll('m1', 'down', 500);
  assert.deepEqual(scrolled.scrollResult, {
    x: 0,
    y: 500,
    moved: true,
    atBoundary: false,
    requested: { x: 0, y: 500 },
  });

  const clicked = await manager.click({ appSessionId: 'm1', ref: '@e1' });
  assert.equal(clicked.scrollResult, undefined);

  const refreshed = await manager.refresh('m1');
  assert.equal(refreshed.scrollResult, undefined);

  await manager.scroll('m1', 'down', 300);
  const opened = await manager.open({ appSessionId: 'm1', url: 'https://example.org' });
  assert.equal(opened.scrollResult, undefined);

  await manager.scroll('m1', 'down', 200);
  const resized = await manager.resizeViewport({
    appSessionId: 'm1',
    viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
    viewportMode: 'custom',
  });
  assert.equal(resized.scrollResult, undefined);
});

test('user address-bar navigation keeps its provenance through the runtime boundary', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });

  await manager.open({
    appSessionId: 'm1',
    url: 'https://www.google.com/search?q=weather',
    source: 'user',
  });

  assert.deepEqual(runtime.openedSources, ['user']);
});

test('addReference captures an anchor crop and current browser context', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const reference = await manager.addReference('m1', { anchor: buttonAnchor() });

  assert.equal(reference.url, 'http://127.0.0.1:1420/');
  assert.equal(reference.viewport.width, 1200);
  assert.equal(reference.anchor.id, reference.id);
  assert.ok(reference.anchor.screenshotPath, 'expected an auto-captured crop path');
  assert.deepEqual(runtime.captures.at(-1), buttonAnchor().box);
});

test('URL navigation invalidates design references and deletes their pending crops', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'navigation-ref', url: 'https://example.com/first' });
  const reference = await manager.addReference('navigation-ref', { anchor: buttonAnchor() });
  const cropPath = reference.anchor.screenshotPath;
  const screenshotPath = await manager.screenshot('navigation-ref');
  assert.ok(cropPath);
  assert.equal((await readFile(cropPath, 'utf8')).length > 0, true);
  assert.equal((await readFile(screenshotPath, 'utf8')).length > 0, true);

  await manager.open({ appSessionId: 'navigation-ref', url: 'https://example.com/second' });

  assert.deepEqual(manager.designContext('navigation-ref').references, []);
  assert.equal(manager.state('navigation-ref')?.screenshotPath, undefined);
  assert.equal(manager.state('navigation-ref')?.screenshotUrl, undefined);
  await assert.rejects(readFile(cropPath), /ENOENT/);
  await assert.rejects(readFile(screenshotPath), /ENOENT/);
});

test('design context keeps only the newest 32 pending references and crops', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'bounded-refs', url: 'https://example.com' });
  let oldestCropPath = '';
  for (let index = 0; index < 33; index += 1) {
    const anchor = buttonAnchor();
    const reference = await manager.addReference('bounded-refs', {
      anchor: {
        ...anchor,
        id: `@ref-${index}`,
        box: { ...anchor.box, x: index },
      },
    });
    if (index === 0) oldestCropPath = reference.anchor.screenshotPath ?? '';
  }

  const references = manager.designContext('bounded-refs').references;
  assert.equal(references.length, 32);
  assert.equal(
    references.some((reference) => reference.id === '@ref-0'),
    false,
  );
  assert.equal(references.at(-1)?.id, '@ref-32');
  await assert.rejects(readFile(oldestCropPath), /ENOENT/);
});

test('replacing a pending design reference deletes its superseded crop', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'replacement-ref', url: 'https://example.com' });
  const first = await manager.addReference('replacement-ref', { anchor: buttonAnchor() });
  const replacementAnchor = buttonAnchor();
  replacementAnchor.box = { ...replacementAnchor.box, x: 99 };
  const replacement = await manager.addReference('replacement-ref', {
    anchor: replacementAnchor,
  });
  assert.ok(first.anchor.screenshotPath);
  assert.ok(replacement.anchor.screenshotPath);

  assert.deepEqual(
    manager.designContext('replacement-ref').references.map((reference) => reference.id),
    ['@live-button'],
  );
  await assert.rejects(readFile(first.anchor.screenshotPath), /ENOENT/);
  assert.equal((await readFile(replacement.anchor.screenshotPath)).length > 0, true);
});

test('closing a session deletes pending crops but preserves saved prompt-pack assets', async () => {
  const manager = createManager({
    writePack: (options) => writeDesignPromptPack({ ...options, baseDir: dataDir }),
  });
  await manager.open({ appSessionId: 'pack-retention', url: 'https://example.com' });
  const packed = await manager.addReference('pack-retention', { anchor: buttonAnchor() });
  const pendingAnchor = buttonAnchor();
  pendingAnchor.id = '@pending';
  pendingAnchor.box = { ...pendingAnchor.box, x: 99 };
  const pending = await manager.addReference('pack-retention', { anchor: pendingAnchor });
  assert.ok(packed.anchor.screenshotPath);
  assert.ok(pending.anchor.screenshotPath);
  const promptPack = await manager.designPrompt({
    appSessionId: 'pack-retention',
    instruction: 'Refine the saved button',
    referenceIds: [packed.id],
  });

  await manager.close('pack-retention');

  assert.equal((await readFile(promptPack.path, 'utf8')).length > 0, true);
  assert.equal((await readFile(packed.anchor.screenshotPath)).length > 0, true);
  await assert.rejects(readFile(pending.anchor.screenshotPath), /ENOENT/);
});

test('fixed-clock captures use unique paths and preserve an earlier prompt-pack image', async (t) => {
  t.mock.method(Date, 'now', () => 123_456);
  let captureCount = 0;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      const runtime = new FakeRuntime(viewport);
      runtime.capture = async (box) => {
        runtime.captures.push(box);
        captureCount += 1;
        return Buffer.from(`crop-${captureCount}`).toString('base64');
      };
      return runtime;
    },
    writePack: (options) => writeDesignPromptPack({ ...options, baseDir: dataDir }),
  });
  await manager.open({ appSessionId: 'unique-image-paths', url: 'https://example.com' });
  const first = await manager.addReference('unique-image-paths', { anchor: buttonAnchor() });
  assert.ok(first.anchor.screenshotPath);
  const promptPack = await manager.designPrompt({
    appSessionId: 'unique-image-paths',
    instruction: 'Preserve this version',
    referenceIds: [first.id],
  });

  const replacement = await manager.addReference('unique-image-paths', {
    anchor: buttonAnchor(),
  });
  assert.ok(replacement.anchor.screenshotPath);
  const firstScreenshot = await manager.screenshot('unique-image-paths');
  const secondScreenshot = await manager.screenshot('unique-image-paths');

  assert.notEqual(replacement.anchor.screenshotPath, first.anchor.screenshotPath);
  assert.notEqual(secondScreenshot, firstScreenshot);
  assert.equal(await readFile(first.anchor.screenshotPath, 'utf8'), 'crop-1');
  assert.equal(await readFile(replacement.anchor.screenshotPath, 'utf8'), 'crop-2');
  assert.equal(
    (await readFile(promptPack.path, 'utf8')).includes(first.anchor.screenshotPath),
    true,
  );
});

test('closeAll closes every runtime when one design cleanup fails', async (t) => {
  let disposeCount = 0;
  t.mock.method(BrowserDesignReferences.prototype, 'dispose', async () => {
    disposeCount += 1;
    if (disposeCount === 1) throw new Error('cleanup failed');
  });
  const closed: string[] = [];
  const manager = createManager({
    runtimeFactory: (_id, viewport, appSessionId) => {
      const runtime = new FakeRuntime(viewport);
      runtime.close = async () => {
        closed.push(appSessionId);
      };
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'cleanup-one', url: 'https://one.example' });
  await manager.open({ appSessionId: 'cleanup-two', url: 'https://two.example' });

  await assert.rejects(manager.closeAll(), /cleanup failed/);

  assert.equal(disposeCount, 2);
  assert.deepEqual(closed.sort(), ['cleanup-one', 'cleanup-two']);
});

test('referenceDetail returns the stored reference with detail', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const reference = await manager.addReference('m1', {
    anchor: buttonAnchor(),
    detail: buttonDetail(),
  });
  const fetched = manager.referenceDetail('m1', reference.id);

  assert.equal(fetched?.detail?.selector, 'button');
  assert.equal(fetched?.detail?.id, reference.id);
});

test('designPrompt writes selected references and trims the instruction', async () => {
  let writtenInstruction = '';
  let writtenReferenceCount = 0;
  const manager = createManager({
    writePack: async (options) => {
      writtenInstruction = options.instruction;
      writtenReferenceCount = options.references.length;
      return {
        path: '/tmp/droid/pack.json',
        pack: {
          appSessionId: options.appSessionId,
          browserSessionId: options.browserSessionId,
          createdAt: '2026-06-07T00:00:00.000Z',
          instruction: options.instruction,
          references: options.references,
        },
      };
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });
  const reference = await manager.addReference('m1', { anchor: buttonAnchor() });

  const result = await manager.designPrompt({
    appSessionId: 'm1',
    instruction: '  Make the button clearer  ',
    referenceIds: [reference.id],
  });

  assert.equal(writtenInstruction, 'Make the button clearer');
  assert.equal(writtenReferenceCount, 1);
  assert.match(result.prompt, /Make the button clearer/);
});

test('designPrompt requires a selected or sketched reference', async () => {
  const manager = createManager();
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await assert.rejects(
    () =>
      manager.designPrompt({
        appSessionId: 'm1',
        instruction: 'Make this clearer',
        referenceIds: [],
      }),
    /Select or sketch at least one browser reference/,
  );
});

test('screenshot forwards high-detail capture options', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await manager.screenshot('m1', { fullPage: true, deviceScaleFactor: 3 });

  assert.deepEqual(runtime.screenshots.at(-1), { fullPage: true, deviceScaleFactor: 3 });
});

test('open resizes an existing runtime before capture', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({
    appSessionId: 'm1',
    url: 'https://example.com',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  });

  const state = await manager.open({
    appSessionId: 'm1',
    url: 'https://example.com',
    viewport: { width: 524, height: 898, deviceScaleFactor: 2 },
    viewportMode: 'fit',
  });

  assert.deepEqual(runtime.viewport, { width: 524, height: 898, deviceScaleFactor: 2 });
  assert.deepEqual(state.viewport, { width: 524, height: 898, deviceScaleFactor: 2 });
});

test('open preserves existing viewport when agent omits viewport', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({
    appSessionId: 'm1',
    url: 'https://example.com',
    viewport: { width: 820, height: 620, deviceScaleFactor: 2 },
    viewportMode: 'custom',
  });

  const state = await manager.open({ appSessionId: 'm1', url: 'https://example.org' });

  assert.deepEqual(runtime.viewport, { width: 820, height: 620, deviceScaleFactor: 2 });
  assert.deepEqual(state.viewport, { width: 820, height: 620, deviceScaleFactor: 2 });
  assert.equal(state.viewportMode, 'custom');
});

test('open normalizes bare domains before the native runtime sees them', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });

  const state = await manager.open({ appSessionId: 'm1', url: 'skeina.tech' });

  assert.equal(runtime.openedUrls[0], 'https://skeina.tech');
  assert.equal(state.url, 'https://skeina.tech');
});

test('a rejected open registers no session', async () => {
  const manager = createManager();

  await assert.rejects(manager.open({ appSessionId: 'm1', url: '' }));
  await assert.rejects(manager.refresh('m1'), /not open yet/);
});

test('reload updates the managed browser state from the runtime snapshot', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'https://example.com' });

  const state = await manager.reload('m1');

  assert.equal(runtime.reloads, 1);
  assert.equal(state.url, 'https://example.com/reloaded');
});

test('history navigation updates browser state through the runtime', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'https://example.com' });

  const back = await manager.goBack('m1');
  const forward = await manager.goForward('m1');

  assert.deepEqual(runtime.history, ['back', 'forward']);
  assert.equal(back.url, 'https://example.com/back');
  assert.equal(forward.url, 'https://example.com/forward');
});

test('open and refresh do not force screenshot capture', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });

  await manager.open({ appSessionId: 'm1', url: 'https://example.com' });
  await manager.refresh('m1');

  assert.equal(runtime.screenshots.length, 0);
});

test('wait backs off and caps full-page snapshot attempts', async () => {
  let runtime!: FakeRuntime;
  const delays: number[] = [];
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      runtime.refs = [];
      return runtime;
    },
    // Keep the synthetic clock below the deadline long enough to prove the
    // snapshot ceiling. If the ceiling regresses, the clock advances so the
    // test fails by call count instead of hanging forever.
    waitNow: () => (delays.length >= 25 ? 10 : 0),
    waitDelay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'https://example.com' });

  await assert.rejects(
    manager.wait('m1', { text: 'never appears', timeoutMs: 10 }),
    /Timed out waiting for the browser condition/,
  );

  assert.equal(runtime.snapshotRequests, 20);
  assert.deepEqual(delays.slice(0, 4), [10, 10, 10, 10]);
  assert.equal(delays.length, 19);
});

test('wait increases the poll interval while respecting its deadline', async () => {
  let runtime!: FakeRuntime;
  let nowMs = 0;
  const delays: number[] = [];
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      runtime.refs = [];
      return runtime;
    },
    waitNow: () => nowMs,
    waitDelay: async (milliseconds) => {
      delays.push(milliseconds);
      nowMs += milliseconds;
    },
  });
  await manager.open({ appSessionId: 'm1', url: 'https://example.com' });

  await assert.rejects(
    manager.wait('m1', { ref: '@missing', timeoutMs: 1_000 }),
    /Timed out waiting for the browser condition/,
  );

  assert.deepEqual(delays, [250, 500, 250]);
  assert.equal(runtime.snapshotRequests, 4);
});

function buttonRef(): BrowserElementRef {
  return {
    ref: '@e1',
    selector: 'button',
    tagName: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    attributes: {},
    box: { x: 10, y: 20, width: 80, height: 30 },
    computedStyles: {},
  };
}

function buttonAnchor(): DesignAnchor {
  return {
    id: '@live-button',
    kind: 'element',
    label: 'Save',
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    box: { x: 10, y: 20, width: 80, height: 30 },
  };
}

function buttonDetail(): DesignAnchorDetail {
  return {
    id: '@live-button',
    selector: 'button',
    selectorVerified: true,
    attributes: {},
    styles: {},
    ancestors: [],
  };
}

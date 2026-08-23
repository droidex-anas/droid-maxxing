import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppBlock, RunningAppFrame } from './AppBlock';
import { AppBlockErrorFallback } from './AppBlockErrorFallback';
import {
  APP_BUILD_TIMEOUT_MS,
  MIN_APP_BUILD_MS,
  appBlockHeightFromMessage,
  appBlockStartupTransition,
  isAppFrameVisible,
  appBlockMathRequestFromMessage,
  appBlockReducer,
  createAppHeightScheduler,
  hasAppBlock,
  hasCompleteAppBlock,
  normalizeAppBlockHeight,
  renderAppBlockMath,
} from './appBlockRuntime';
import { createAppDocument } from './appBlockDocument';

test('Play starts an app and Stop releases it back to the inert preview', () => {
  assert.equal(appBlockReducer('idle', 'play'), 'running');
  assert.equal(appBlockReducer('running', 'stop'), 'idle');
});

test('only a closed app fence is ready for automatic playback', () => {
  assert.equal(hasAppBlock('```app\n<main>Streaming'), true);
  assert.equal(hasAppBlock('```app\r\n<main>Streaming'), true);
  assert.equal(hasAppBlock('```application\nnope\n```'), false);
  assert.equal(hasCompleteAppBlock('```app\n<main>Streaming'), false);
  assert.equal(hasCompleteAppBlock('```app\n<main>Complete</main>\n```'), true);
  assert.equal(hasCompleteAppBlock('```app\r\n<main>Complete</main>\r\n```'), true);
  assert.equal(hasCompleteAppBlock('```application\nnope\n```'), false);
  assert.equal(hasAppBlock('````markdown\n```app\nexample\n```\n````'), false);
  assert.equal(hasCompleteAppBlock('````markdown\n```app\nexample\n```\n````'), false);
});

test('an app under construction is a status surface with no executable control', () => {
  const html = renderToStaticMarkup(
    createElement(AppBlock, {
      source: '<main><script>const points = [',
      isBuilding: true,
    }),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /Building interactive app/);
  assert.match(html, /shimmer-text/);
  assert.doesNotMatch(html, /aria-label="Play app"/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /const points/);
});

test('an App with a cut-off source offers no playback control', () => {
  const html = renderToStaticMarkup(
    createElement(AppBlock, {
      source: '<main><script>const points = [',
      isCutOff: true,
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Saved history kept only part/);
  assert.doesNotMatch(html, /aria-label="Play app"/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /const points/);
});

test('the running document is self-contained and blocks network and nested content', () => {
  const source =
    '<main><h1>Responsive app</h1></main><script>document.body.dataset.ready="yes"</script>';
  const document = createAppDocument(source, 'app-1', {
    colorScheme: 'light',
    background: '#f7f7f5',
    surface: '#ffffff',
    foreground: '#202020',
    muted: '#666666',
    border: '#dddddd',
    accent: '#2f6fed',
  });

  assert.match(document, /default-src 'none'/);
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /frame-src 'none'/);
  assert.match(document, /form-action 'none'/);
  assert.match(document, /<meta name="viewport"/);
  assert.match(document, /droidex:app-height/);
  assert.match(document, /bridgeToken/);
  // The host hides the frame until it reports a height, and a hidden frame runs
  // no animation frames, so the report must not wait for one.
  assert.doesNotMatch(document, /requestAnimationFrame/);
  assert.match(document, /observer\.observe\(document\.body\)/);
  assert.match(document, /"app-1"/);
  assert.match(document, /color-scheme: light/);
  assert.match(document, /--app-background: #f7f7f5/);
  assert.match(document, /--app-foreground: #202020/);
  assert.match(document, /--app-accent: #2f6fed/);
  assert.match(document, /background: transparent/);
  assert.doesNotMatch(document, /background: var\(--app-background\) !important/);
  assert.doesNotMatch(document, /\[data-droidex-app-root\] \{[\s\S]*?\n {2}background:/);
  assert.doesNotMatch(document, /\[data-droidex-app-canvas\] \{[\s\S]*?\n {2}background:/);
  assert.match(document, /padding: 0/);
  assert.match(document, /\[data-droidex-app-root\]/);
  assert.match(document, /\[data-droidex-app-canvas\]/);
  assert.match(document, /max-width: none !important/);
  assert.doesNotMatch(document, /\[data-droidex-app-root\] \{[^}]*border-radius:\s*0\s*!important/);
  assert.match(document, /window\.droidex/);
  assert.match(document, /\[data-latex\]/);
  assert.match(document, /droidex:render-math/);
  assert.match(document, /droidex:math-rendered/);
  assert.match(document, /<main><h1>Responsive app<\/h1><\/main>/);
});

test('reported app heights grow with the chat instead of creating a short nested scroller', () => {
  assert.equal(normalizeAppBlockHeight(40), 240);
  assert.equal(normalizeAppBlockHeight(412.2), 413);
  assert.equal(normalizeAppBlockHeight(4_000), 4_000);
  assert.equal(normalizeAppBlockHeight(20_000), 12_000);
  assert.equal(normalizeAppBlockHeight(Number.NaN), 360);
});

test('restored app blocks are compact and keep source inert behind Play', () => {
  const html = renderToStaticMarkup(
    createElement(AppBlock, { source: '<button>Private source</button>' }),
  );

  assert.match(html, /Interactive App/);
  assert.match(html, /aria-label="Play app"/);
  assert.doesNotMatch(html, /Private source/);
  assert.doesNotMatch(html, /<iframe/i);
});

test('a freshly completed app opens directly on the chat canvas', () => {
  const html = renderToStaticMarkup(
    createElement(AppBlock, { source: '<main>Fresh app</main>', autoPlay: true }),
  );

  assert.match(html, /<iframe/i);
  assert.match(html, /aria-label="Stop app"/);
  assert.ok(html.indexOf('<iframe') < html.indexOf('aria-label="Stop app"'));
  assert.doesNotMatch(html, /overflow-hidden/);
  assert.doesNotMatch(html, /absolute right-2 top-2/);
  assert.doesNotMatch(html, />App<\/span>/);
});

test('manual Play reveals the stable App anchor at the top of the viewport', async () => {
  type RevealAppBlock = (element: HTMLElement | null, reduceMotion: boolean) => void;
  const appBlockModule = (await import('./AppBlock')) as unknown as {
    revealAppBlock?: RevealAppBlock;
  };
  const reveal = appBlockModule.revealAppBlock;
  assert.equal(typeof reveal, 'function');
  if (!reveal) return;

  const calls: ScrollIntoViewOptions[] = [];
  const element = {
    scrollIntoView(options: ScrollIntoViewOptions) {
      calls.push(options);
    },
  } as HTMLElement;
  reveal(element, false);

  assert.deepEqual(calls, [{ behavior: 'smooth', block: 'start', inline: 'nearest' }]);
});

test('the running frame keeps app code inside a script-only sandbox', () => {
  const html = renderToStaticMarkup(
    createElement(RunningAppFrame, {
      source: '<button>Safe app</button>',
      instanceId: 'app-2',
    }),
  );

  assert.match(html, /<iframe/i);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /title="Interactive App block"/);
  assert.doesNotMatch(html, /transition-\[height\]/);
});

test('a started App builds behind a status surface until it reports its size', () => {
  const html = renderToStaticMarkup(
    createElement(RunningAppFrame, {
      source: '<button>Slow app</button>',
      instanceId: 'app-build',
    }),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /Starting interactive app/);
  // The frame still loads while hidden, and stays out of the reading and tab
  // order until it is revealed at its measured height.
  assert.match(html, /loading="eager"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /tabindex="-1"/i);
  // Off-layout, so the hidden frame's default height cannot reserve space the
  // measured App will not use.
  assert.match(html, /invisible pointer-events-none absolute inset-x-0 top-0/);
});

test('the build surface waits for a measurement but never hides a silent App', () => {
  assert.equal(
    isAppFrameVisible({ measured: true, floorElapsed: false, expired: false }),
    false,
    'a measurement inside the build floor must not flash the frame open',
  );
  assert.equal(isAppFrameVisible({ measured: false, floorElapsed: true, expired: false }), false);
  assert.equal(isAppFrameVisible({ measured: true, floorElapsed: true, expired: false }), true);
  assert.equal(
    isAppFrameVisible({ measured: false, floorElapsed: true, expired: true }),
    true,
    'an App that never reports a height is still revealed',
  );
  assert.ok(MIN_APP_BUILD_MS < APP_BUILD_TIMEOUT_MS);
});

test('height reports coalesce on a timer so a hidden host window still measures', () => {
  // Regression: the host applied measured heights on an animation frame, which
  // a hidden or minimized window never runs. The frame stays behind its build
  // surface until a height lands, so that report cannot depend on painting.
  const applied: number[] = [];
  const scheduler = createAppHeightScheduler((height) => applied.push(height));

  scheduler.schedule(400);
  scheduler.schedule(520);
  scheduler.schedule(610);
  assert.deepEqual(applied, [], 'a burst applies nothing synchronously');

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(applied, [610], 'a burst collapses into the newest height');

      scheduler.schedule(700);
      scheduler.cancel();
      setTimeout(() => {
        assert.deepEqual(applied, [610], 'a cancelled scheduler applies nothing');
        resolve();
      });
    });
  });
});

test('a script failure is reported before the App can announce readiness', () => {
  const document = createAppDocument(
    '<script>const broken = ;</script>',
    'app-error',
    undefined,
    'token',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(script);
  const listeners = new Map<string, (event: unknown) => void>();
  const messages: unknown[] = [];
  const parent = {
    postMessage(message: unknown) {
      messages.push(message);
    },
  };

  vm.runInNewContext(script, {
    parent,
    window: {},
    Element: class {},
    document: {},
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    ResizeObserver: class {},
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
    removeEventListener: () => undefined,
  });

  listeners.get('error')?.({ message: 'Invalid or unexpected token' });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    {
      type: 'droidex:app-error',
      instanceId: 'app-error',
      bridgeToken: 'token',
      message: 'Invalid or unexpected token',
    },
  ]);

  messages.length = 0;
  listeners.get('unhandledrejection')?.({ reason: new Error('   ') });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    {
      type: 'droidex:app-error',
      instanceId: 'app-error',
      bridgeToken: 'token',
      message: 'The interactive App failed to start.',
    },
  ]);
});

test('a working App is not torn down by a later interaction error', () => {
  const ready = appBlockStartupTransition(
    'waiting',
    {
      type: 'droidex:app-ready',
      instanceId: 'app-error',
      bridgeToken: 'token',
    },
    'app-error',
    'token',
  );
  assert.deepEqual(ready, { state: 'ready' });

  const afterInteractionError = appBlockStartupTransition(
    ready.state,
    {
      type: 'droidex:app-error',
      instanceId: 'app-error',
      bridgeToken: 'token',
      message: 'Click handler failed',
    },
    'app-error',
    'token',
  );
  assert.deepEqual(afterInteractionError, { state: 'ready' });
});

test('the host accepts bounded runtime errors only from the mounted App document', async () => {
  const runtime = (await import('./appBlockRuntime')) as unknown as {
    appBlockErrorFromMessage?: (
      data: unknown,
      instanceId: string,
      bridgeToken: string,
    ) => string | undefined;
  };
  const appBlockErrorFromMessage = runtime.appBlockErrorFromMessage;
  assert.equal(typeof appBlockErrorFromMessage, 'function');
  if (!appBlockErrorFromMessage) return;
  assert.equal(
    appBlockErrorFromMessage(
      {
        type: 'droidex:app-error',
        instanceId: 'app-error',
        bridgeToken: 'token',
        message: 'Invalid or unexpected token',
      },
      'app-error',
      'token',
    ),
    'Invalid or unexpected token',
  );
  assert.equal(
    appBlockErrorFromMessage(
      {
        type: 'droidex:app-error',
        instanceId: 'app-error',
        bridgeToken: 'wrong',
        message: 'Invalid or unexpected token',
      },
      'app-error',
      'token',
    ),
    undefined,
  );
  assert.equal(
    appBlockErrorFromMessage(
      {
        type: 'droidex:app-error',
        instanceId: 'app-error',
        bridgeToken: 'token',
        message: 'x'.repeat(501),
      },
      'app-error',
      'token',
    ),
    undefined,
  );
});

test('a failed App renders a compact recovery surface instead of a blank canvas', () => {
  const html = renderToStaticMarkup(
    createElement(AppBlockErrorFallback, {
      message: 'Invalid or unexpected token',
    }),
  );
  assert.match(html, /Interactive App couldn’t start/);
  assert.match(html, /Ask Droid to fix this visualization/);
  assert.match(html, /Invalid or unexpected token/);
});

test('the host accepts height updates only for the mounted app instance', () => {
  assert.equal(
    appBlockHeightFromMessage(
      { type: 'droidex:app-height', instanceId: 'app-3', height: 420.4 },
      'app-3',
    ),
    421,
  );
  assert.equal(
    appBlockHeightFromMessage(
      { type: 'droidex:app-height', instanceId: 'other', height: 420 },
      'app-3',
    ),
    undefined,
  );
  assert.equal(
    appBlockHeightFromMessage({ type: 'other', instanceId: 'app-3', height: 420 }, 'app-3'),
    undefined,
  );
  assert.equal(appBlockHeightFromMessage(null, 'app-3'), undefined);
});

test('the host bridge rejects messages without the initial document token', () => {
  assert.equal(
    appBlockHeightFromMessage(
      { type: 'droidex:app-height', instanceId: 'app-3', bridgeToken: 'wrong', height: 420 },
      'app-3',
      'expected',
    ),
    undefined,
  );
  assert.equal(
    appBlockMathRequestFromMessage(
      {
        type: 'droidex:render-math',
        instanceId: 'app-4',
        bridgeToken: 'wrong',
        requestId: 'math-1',
        latex: 'x',
        displayMode: false,
      },
      'app-4',
      'expected',
    ),
    undefined,
  );
});

test('the App bridge bounds math work and deduplicates repeated heights', async () => {
  type Guard = {
    acceptHeight: (height: number) => boolean;
    startMath: () => boolean;
    finishMath: () => void;
  };
  const runtime = (await import('./appBlockRuntime')) as unknown as {
    createAppBridgeGuard?: (mathBudget: number, mathConcurrency: number) => Guard;
  };
  const guard = runtime.createAppBridgeGuard?.(2, 1);
  assert.ok(guard);
  assert.equal(guard.acceptHeight(400), true);
  assert.equal(guard.acceptHeight(400), false);
  assert.equal(guard.startMath(), true);
  assert.equal(guard.startMath(), false);
  guard.finishMath();
  assert.equal(guard.startMath(), true);
  guard.finishMath();
  assert.equal(guard.startMath(), false);
});

test('a failed App cannot resize the chat after its recovery surface is selected', async () => {
  type Guard = {
    acceptHeight: (height: number) => boolean;
    fail?: () => void;
  };
  const runtime = (await import('./appBlockRuntime')) as unknown as {
    createAppBridgeGuard?: () => Guard;
  };
  const guard = runtime.createAppBridgeGuard?.();
  assert.ok(guard);
  assert.equal(typeof guard.fail, 'function');
  if (!guard.fail) return;

  guard.fail();
  assert.equal(guard.acceptHeight(1_366), false);
});

test('each iframe document gets an independent bridge token and work budget', async () => {
  type BridgeSession = {
    token: string;
    guard: {
      startMath: () => boolean;
      finishMath: () => void;
    };
  };
  const runtime = (await import('./appBlockRuntime')) as unknown as {
    createAppBridgeSession?: () => BridgeSession;
  };
  assert.equal(typeof runtime.createAppBridgeSession, 'function');
  if (!runtime.createAppBridgeSession) return;

  const first = runtime.createAppBridgeSession();
  const second = runtime.createAppBridgeSession();
  assert.notEqual(first.token, second.token);
  assert.equal(first.guard.startMath(), true);
  assert.equal(first.guard.startMath(), true);
  assert.equal(first.guard.startMath(), false);
  assert.equal(second.guard.startMath(), true);
});

test('the iframe document repeats readiness for each valid host handshake', () => {
  const document = createAppDocument('<main>Ready</main>', 'app-ready', undefined, 'token');
  const script = /<script>([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(script);
  const listeners = new Map<string, (event: { source: object; data: unknown }) => void>();
  const messages: unknown[] = [];
  const parent = {
    postMessage(message: unknown) {
      messages.push(message);
    },
  };

  vm.runInNewContext(script, {
    parent,
    window: {},
    Element: class {},
    document: {},
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    ResizeObserver: class {},
    addEventListener(type: string, listener: (event: { source: object; data: unknown }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener: () => undefined,
  });

  const onMessage = listeners.get('message');
  assert.ok(onMessage);
  const handshake = {
    source: parent,
    data: {
      type: 'droidex:host-ready',
      instanceId: 'app-ready',
      bridgeToken: 'token',
    },
  };
  onMessage(handshake);
  onMessage(handshake);
  onMessage({
    ...handshake,
    data: { ...handshake.data, bridgeToken: 'wrong' },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: 'droidex:app-ready', instanceId: 'app-ready', bridgeToken: 'token' },
    { type: 'droidex:app-ready', instanceId: 'app-ready', bridgeToken: 'token' },
  ]);
});

test('the iframe reports its initial height only after built-in math settles', async () => {
  const documentHtml = createAppDocument(
    '<main><span data-latex="x^2">x²</span></main>',
    'app-math-height',
    undefined,
    'token',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(documentHtml)?.[1];
  assert.ok(script);

  class TestElement {
    innerHTML = '';
    textContent = '';
    tagName = 'SPAN';
    children: TestElement[] = [];
    scrollHeight = 500;

    getAttribute(name: string) {
      return name === 'data-latex' ? 'x^2' : null;
    }
    hasAttribute() {
      return false;
    }
    matches() {
      return false;
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    setAttribute() {}
  }

  const mathElement = new TestElement();
  const body = new TestElement();
  body.tagName = 'BODY';
  const documentElement = { scrollHeight: 500 };
  const runtimeDocument = {
    body,
    documentElement,
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector === '[data-latex]' ? [mathElement] : []),
  };
  const listeners = new Map<string, (event?: { source?: object; data?: unknown }) => void>();
  const messages: Record<string, unknown>[] = [];
  const pendingReports: (() => void)[] = [];
  let observerCallback: (() => void) | undefined;
  const parent = {
    postMessage(message: Record<string, unknown>) {
      messages.push(message);
    },
  };

  vm.runInNewContext(script, {
    parent,
    window: {},
    Element: TestElement,
    document: runtimeDocument,
    setTimeout(callback: () => void) {
      pendingReports.push(callback);
      return pendingReports.length;
    },
    clearTimeout: () => undefined,
    ResizeObserver: class {
      constructor(callback: () => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
    addEventListener(
      type: string,
      listener: (event?: { source?: object; data?: unknown }) => void,
    ) {
      listeners.set(type, listener);
    },
    removeEventListener: () => undefined,
  });

  listeners.get('DOMContentLoaded')?.();
  assert.ok(observerCallback);
  // A resize before math settles must not publish the pre-math layout: the host
  // shows the App at its first reported height.
  observerCallback();
  while (pendingReports.length > 0) pendingReports.shift()?.();
  assert.equal(
    messages.some((message) => message.type === 'droidex:app-height'),
    false,
  );

  body.scrollHeight = 600;
  documentElement.scrollHeight = 600;
  listeners.get('message')?.({
    source: parent,
    data: {
      type: 'droidex:math-rendered',
      instanceId: 'app-math-height',
      bridgeToken: 'token',
      requestId: 'app-math-height-math-1',
      html: '<math></math>',
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  while (pendingReports.length > 0) pendingReports.shift()?.();

  assert.deepEqual(
    JSON.parse(JSON.stringify(messages.filter((message) => message.type === 'droidex:app-height'))),
    [
      {
        type: 'droidex:app-height',
        instanceId: 'app-math-height',
        bridgeToken: 'token',
        height: 600,
      },
    ],
  );
});

test('short and functional CSS colors select the correct canvas scheme', async () => {
  const runtime = (await import('./appBlockRuntime')) as unknown as {
    appColorScheme?: (color: string) => 'light' | 'dark';
  };
  assert.equal(runtime.appColorScheme?.('#fff'), 'light');
  assert.equal(runtime.appColorScheme?.('rgb(250, 250, 250)'), 'light');
  assert.equal(runtime.appColorScheme?.('hsl(0, 0%, 5%)'), 'dark');
  assert.equal(runtime.appColorScheme?.('#111111ff'), 'dark');
});

test('the math bridge accepts only bounded requests for the mounted App', () => {
  assert.deepEqual(
    appBlockMathRequestFromMessage(
      {
        type: 'droidex:render-math',
        instanceId: 'app-4',
        requestId: 'math-1',
        latex: String.raw`y = \beta_0 + \beta_1 x`,
        displayMode: true,
      },
      'app-4',
    ),
    {
      requestId: 'math-1',
      latex: String.raw`y = \beta_0 + \beta_1 x`,
      displayMode: true,
    },
  );
  assert.equal(
    appBlockMathRequestFromMessage(
      {
        type: 'droidex:render-math',
        instanceId: 'other',
        requestId: 'math-1',
        latex: 'x',
        displayMode: false,
      },
      'app-4',
    ),
    undefined,
  );
  assert.equal(
    appBlockMathRequestFromMessage(
      {
        type: 'droidex:render-math',
        instanceId: 'app-4',
        requestId: 'math-1',
        latex: 'x'.repeat(20_001),
        displayMode: false,
      },
      'app-4',
    ),
    undefined,
  );
});

test('the local math renderer produces native MathML without iframe network access', async () => {
  const html = await renderAppBlockMath({
    requestId: 'math-2',
    latex: String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
    displayMode: true,
  });

  assert.match(html, /<math/);
  assert.match(html, /display="block"/);
  assert.match(html, /<mfrac>/);
  assert.doesNotMatch(html, /<script/i);
});

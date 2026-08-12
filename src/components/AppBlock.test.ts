import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppBlock, RunningAppFrame } from './AppBlock';
import {
  appBlockHeightFromMessage,
  appBlockReducer,
  createAppDocument,
  hasCompleteAppBlock,
  normalizeAppBlockHeight,
} from './appBlockRuntime';

test('Play starts an app and Stop releases it back to the inert preview', () => {
  assert.equal(appBlockReducer('idle', 'play'), 'running');
  assert.equal(appBlockReducer('running', 'stop'), 'idle');
});

test('only a closed app fence is ready for automatic playback', () => {
  assert.equal(hasCompleteAppBlock('```app\n<main>Streaming'), false);
  assert.equal(hasCompleteAppBlock('```app\n<main>Complete</main>\n```'), true);
  assert.equal(hasCompleteAppBlock('```application\nnope\n```'), false);
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
  assert.match(document, /"app-1"/);
  assert.match(document, /color-scheme: light/);
  assert.match(document, /--app-background: #f7f7f5/);
  assert.match(document, /--app-foreground: #202020/);
  assert.match(document, /--app-accent: #2f6fed/);
  assert.match(document, /background: transparent/);
  assert.match(document, /padding: 0/);
  assert.match(document, /<main><h1>Responsive app<\/h1><\/main>/);
});

test('reported app heights grow with the chat instead of creating a short nested scroller', () => {
  assert.equal(normalizeAppBlockHeight(40), 240);
  assert.equal(normalizeAppBlockHeight(412.2), 413);
  assert.equal(normalizeAppBlockHeight(4_000), 1_400);
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
  assert.doesNotMatch(html, />App<\/span>/);
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

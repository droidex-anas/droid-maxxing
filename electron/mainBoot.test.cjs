const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

const DEFERRED_MODULES = [
  './git.cjs',
  './github.cjs',
  './githubPrConversation.cjs',
  './terminal.cjs',
  './terminalPort.cjs',
  './performanceMetrics.cjs',
  './files.cjs',
  './attachments.cjs',
  './appUpdater.cjs',
  './rendererOomRecovery.cjs',
];

test('registerIpc runs before createMainWindow in app.whenReady', () => {
  const readyStart = mainSource.indexOf('app.whenReady().then(async () => {');
  const readyBlock = mainSource.slice(readyStart, readyStart + 600);
  const registerAt = readyBlock.indexOf('registerIpc();');
  const createAt = readyBlock.indexOf('createMainWindow();');
  assert.ok(registerAt >= 0 && createAt > registerAt);
});

test('deferred electron modules load through lazy getters instead of top-level requires', () => {
  for (const moduleName of DEFERRED_MODULES) {
    assert.doesNotMatch(
      mainSource,
      new RegExp(`^const [^=]+ = require\\('${moduleName.replace('.', '\\.')}'\\);`, 'm'),
      `${moduleName} must not be a top-level require`,
    );
    assert.match(
      mainSource,
      new RegExp(`require\\('${moduleName.replace('.', '\\.')}'\\)`),
      `${moduleName} must still be reachable via lazy require`,
    );
  }
});

test('lazy git getter caches its module', () => {
  assert.match(
    mainSource,
    /let gitVcsModule;\s*function gitVcs\(\) \{\s*gitVcsModule \?\?= require\('\.\/git\.cjs'\);/,
  );
});

test('diagnostics initialize before app readiness', () => {
  const disableAt = mainSource.indexOf('app.disableHardwareAcceleration();');
  const initializeAt = mainSource.indexOf(
    'const diagnosticsInitialization = diagnostics.initialize();',
  );
  const readyAt = mainSource.indexOf('app.whenReady().then(async () =>');
  assert.ok(disableAt > 0 && disableAt < initializeAt);
  assert.ok(initializeAt > 0 && initializeAt < readyAt);
});

test('diagnostics initialize reports init failures without aborting startup capture', async () => {
  const { createDiagnostics } = require('./diagnostics.cjs');
  const logged = [];
  const diagnostics = createDiagnostics({
    app: { getVersion: () => '0.0.0', isPackaged: false, getPath: () => '/tmp' },
    sentry: {
      init: () => {
        throw new Error('sentry init failed');
      },
      captureException: () => undefined,
    },
    dsn: 'https://example@o0.ingest.sentry.io/0',
    logError: (message, error) => logged.push({ message, error }),
  });
  const initialized = await diagnostics.initialize();
  assert.equal(initialized, false);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0].message), /Sentry initialization skipped/);
});

test('main boot defers measurable optional require cost', () => {
  const electronDir = path.join(__dirname);
  const deferred = [
    'git.cjs',
    'github.cjs',
    'githubPrConversation.cjs',
    'terminal.cjs',
    'terminalPort.cjs',
    'performanceMetrics.cjs',
    'files.cjs',
    'attachments.cjs',
    'appUpdater.cjs',
    'rendererOomRecovery.cjs',
  ];
  const start = performance.now();
  for (const name of deferred) {
    delete require.cache[path.join(electronDir, name)];
    require(path.join(electronDir, name));
  }
  const deferredMs = performance.now() - start;
  assert.ok(deferredMs > 1, 'deferred bundle should be measurable');
});

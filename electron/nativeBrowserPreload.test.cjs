const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'nativeBrowserPreload.cjs'), 'utf8');

test('only a trusted physical action reports an exact, immediately expiring navigation intent', () => {
  const start = source.indexOf('function reportTrustedUserNavigation(event)');
  const end = source.indexOf('\nfunction trustedUserNavigationDestination', start);
  assert.ok(start >= 0 && end > start, 'trusted user navigation reporter must exist');
  const sent = [];
  const timers = [];
  const report = vm.runInNewContext(
    `(${source.slice(start, end).replace('function reportTrustedUserNavigation', 'function')})`,
    {
      capturePending: false,
      consumeTrustedPhysicalFormActivation: () => true,
      crypto: { randomUUID: () => 'activation-1' },
      designMode: false,
      ipcRenderer: { send: (...args) => sent.push(args) },
      setTimeout: (callback, timeoutMs) => timers.push({ callback, timeoutMs }),
      trustedUserNavigationDestination: () => 'https://accounts.example/sign-in',
    },
  );

  report({ isTrusted: false });
  assert.deepEqual(sent, []);

  report({ isTrusted: true, type: 'click' });
  assert.deepEqual(sent, [
    [
      'native-browser-user-navigation',
      {
        activationId: 'activation-1',
        destinationUrl: 'https://accounts.example/sign-in',
      },
    ],
  ]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].timeoutMs, 0);
  timers[0].callback();
  assert.deepEqual(sent[1], [
    'native-browser-user-navigation-expired',
    { activationId: 'activation-1' },
  ]);
});

test('a programmatic form submit cannot report user navigation without trusted physical input', () => {
  const start = source.indexOf('function reportTrustedUserNavigation(event)');
  const end = source.indexOf('\nfunction trustedUserNavigationDestination', start);
  const sent = [];
  const report = vm.runInNewContext(
    `(${source.slice(start, end).replace('function reportTrustedUserNavigation', 'function')})`,
    {
      capturePending: false,
      consumeTrustedPhysicalFormActivation: () => false,
      crypto: { randomUUID: () => 'activation-2' },
      designMode: false,
      ipcRenderer: { send: (...args) => sent.push(args) },
      setTimeout: () => {},
      trustedUserNavigationDestination: () => 'https://accounts.example/sign-in',
    },
  );

  report({ isTrusted: true, type: 'submit', target: {} });
  assert.deepEqual(sent, []);
});

test('trusted navigation destination accepts only real link and form defaults', () => {
  const start = source.indexOf('function trustedUserNavigationDestination(event)');
  const end = source.indexOf('\nfunction onClick', start);
  assert.ok(start >= 0 && end > start, 'trusted navigation destination resolver must exist');
  class FormData {
    constructor(form) {
      this.values = form.values;
    }
    *[Symbol.iterator]() {
      yield* this.values;
    }
  }
  const resolve = vm.runInNewContext(
    `(${source
      .slice(start, end)
      .replace('function trustedUserNavigationDestination', 'function')})`,
    {
      FormData,
      URL,
      URLSearchParams,
      location: { href: 'https://app.example/current' },
    },
  );
  const anchor = {
    href: 'https://accounts.example/sign-in',
    hasAttribute: () => false,
  };

  assert.equal(
    resolve({
      type: 'click',
      defaultPrevented: false,
      button: 0,
      target: { closest: () => anchor },
    }),
    'https://accounts.example/sign-in',
  );
  assert.equal(
    resolve({
      type: 'click',
      defaultPrevented: true,
      button: 0,
      target: { closest: () => anchor },
    }),
    null,
  );
  assert.equal(
    resolve({
      type: 'submit',
      defaultPrevented: false,
      target: {
        tagName: 'FORM',
        action: 'https://search.example/find?old=ignored',
        method: 'get',
        values: [
          ['q', 'droidex browser'],
          ['lang', 'en'],
        ],
      },
      submitter: null,
    }),
    'https://search.example/find?q=droidex+browser&lang=en',
  );
});

test('diagnostic URLs redact secrets and fail closed for malformed input', () => {
  const start = source.indexOf('const SENSITIVE_URL_KEY_PARTS');
  const end = source.indexOf('\nlet designMode', start);
  const redact = vm.runInNewContext(
    `(() => {\n${source.slice(start, end)}\nreturn redactBrowserDiagnosticUrl;\n})()`,
    { URL },
  );

  assert.equal(
    redact('https://example.test/callback?state=private&safe=yes'),
    'https://example.test/callback?state=%5Bredacted%5D&safe=yes',
  );
  assert.equal(
    redact('https://[malformed]?token=super-secret', 'https://example.test/'),
    '[invalid URL]',
  );
});

test('final page execution rejects a replaced document, snapshot, or in-page URL', () => {
  const start = source.indexOf('function requireCurrentAgentActionContext(expected)');
  const end = source.indexOf('\nfunction requireSafeAgentTextAction', start);
  const current = { documentId: 'document-1', snapshotId: 'document-1:8', urlHash: 'url-1' };
  const requireContext = vm.runInNewContext(
    `(${source
      .slice(start, end)
      .replace('function requireCurrentAgentActionContext', 'function')})`,
    { browserAgentActionContext: () => current },
  );

  assert.doesNotThrow(() => requireContext({ ...current }));
  for (const expected of [
    { ...current, documentId: 'document-old' },
    { ...current, snapshotId: 'document-1:7' },
    { ...current, urlHash: 'url-old' },
  ]) {
    assert.throws(
      () => requireContext(expected),
      /page changed before the browser action completed/,
    );
  }
});

test('snapshot recovery mints a new lease when in-page navigation cleared the old one', async () => {
  const start = source.indexOf('async function runAgentAction(request)');
  const end = source.indexOf('\nfunction clickAt', start);
  let agentSnapshotId = '';
  let contextChecks = 0;
  const runAction = vm.runInNewContext(
    `(${source.slice(start, end).replace('async function runAgentAction', 'async function')})`,
    {
      finishScrollAttempt: () => undefined,
      pageSnapshot: () => {
        agentSnapshotId = 'document-new:1';
        return { refs: [], snapshotId: agentSnapshotId };
      },
      requireCurrentAgentActionContext: () => {
        contextChecks += 1;
      },
      safeSnapshot: () => ({ refs: [] }),
      sendAgent: (result) => result,
      settle: async () => {},
    },
  );

  const result = await runAction({ requestId: 'snapshot-recovery', action: 'snapshot' });

  assert.equal(contextChecks, 0);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.snapshotId, 'document-new:1');
  assert.equal(agentSnapshotId, 'document-new:1');
});

test('hover validates the current target without dispatching a synthetic mouse event', async () => {
  const start = source.indexOf('function validateHoverTargetAt(x, y, expectedTarget)');
  const end = source.indexOf('\nfunction typeIntoFocused', start);
  const target = {
    dispatchCount: 0,
    dispatchEvent() {
      this.dispatchCount += 1;
    },
  };
  const hover = vm.runInNewContext(
    `(${source.slice(start, end).replace('function validateHoverTargetAt', 'function')})`,
    {
      MouseEvent: class {},
      document: { elementFromPoint: () => target },
      requirePointOnExpectedTarget: (actual, expected) => assert.equal(actual, expected),
    },
  );

  hover(40, 60, target);

  assert.equal(target.dispatchCount, 0);
});

test('hover action validates its exact context and target without minting a premature snapshot', async () => {
  const start = source.indexOf('async function runAgentAction(request)');
  const end = source.indexOf('\nfunction clickAt', start);
  const target = {};
  const context = {
    documentId: 'document-1',
    snapshotId: 'document-1:4',
    urlHash: 'url-1',
  };
  let contextChecks = 0;
  let targetChecks = 0;
  let snapshotCount = 0;
  const runAction = vm.runInNewContext(
    `(${source.slice(start, end).replace('async function runAgentAction', 'async function')})`,
    {
      validateHoverTargetAt: (x, y, expectedTarget) => {
        assert.equal(x, 40);
        assert.equal(y, 60);
        assert.equal(expectedTarget, target);
      },
      pageSnapshot: () => {
        snapshotCount += 1;
        return { refs: [] };
      },
      requireCurrentAgentActionContext: (context) => {
        contextChecks += 1;
        assert.deepEqual(context, {
          documentId: 'document-1',
          snapshotId: 'document-1:4',
          urlHash: 'url-1',
        });
      },
      requireCurrentAgentSnapshotTarget: (ref, selector) => {
        targetChecks += 1;
        assert.equal(ref, '@b-account');
        assert.equal(selector, '#account');
        return target;
      },
      safeSnapshot: () => ({ refs: [] }),
      sendAgent: (result) => result,
      settle: async () => {},
    },
  );

  const result = await runAction({
    requestId: 'request-hover',
    action: 'hover',
    ref: '@b-account',
    selector: '#account',
    x: 40,
    y: 60,
    __droidexContext: context,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { requestId: 'request-hover', ok: true });
  assert.equal(contextChecks, 1);
  assert.equal(targetChecks, 1);
  assert.equal(snapshotCount, 0);
});

test('the isolated final action rechecks sensitive focus immediately before typing', () => {
  const start = source.indexOf('function requireSafeAgentTextAction(request)');
  const end = source.indexOf('\nfunction currentAgentSnapshotTarget', start);
  let sensitive = null;
  const requireSafeText = vm.runInNewContext(
    `(${source.slice(start, end).replace('function requireSafeAgentTextAction', 'function')})`,
    { sensitiveFocusedField: () => sensitive },
  );

  assert.doesNotThrow(() => requireSafeText({ action: 'type' }));
  sensitive = { kind: 'password' };
  assert.throws(() => requireSafeText({ action: 'type' }), /password field/);
  assert.throws(() => requireSafeText({ action: 'keypress', key: 'a' }), /password field/);
  assert.doesNotThrow(() => requireSafeText({ action: 'keypress', key: 'Enter' }));

  const actionStart = source.indexOf('async function runAgentAction(request)');
  const actionEnd = source.indexOf('\nfunction clickAt', actionStart);
  const action = source.slice(actionStart, actionEnd);
  assert.match(action, /requireSafeAgentTextAction\(request\);\s*typeIntoFocused/);
  assert.match(action, /requireSafeAgentTextAction\(request\);\s*pressKey/);
});

test('replacing an element with the same selector expires the old browser ref', () => {
  const start = source.indexOf('function currentAgentSnapshotTarget(ref, selector)');
  const end = source.indexOf('\nfunction requireCurrentAgentSnapshotTarget', start);
  const document = {};
  class Element {}
  const snapshottedElement = Object.assign(new Element(), {
    isConnected: true,
    ownerDocument: document,
  });
  const replacementElement = Object.assign(new Element(), {
    isConnected: true,
    ownerDocument: document,
  });
  document.querySelector = () => replacementElement;
  const agentSnapshotTargets = new Map([
    ['@b-current', { element: snapshottedElement, selector: '#continue' }],
  ]);
  const currentTarget = vm.runInNewContext(
    `(${source.slice(start, end).replace('function currentAgentSnapshotTarget', 'function')})`,
    { agentSnapshotId: 'document:1', agentSnapshotTargets, document, Element },
  );

  assert.equal(currentTarget('@b-current', '#continue'), snapshottedElement);
  assert.equal(currentTarget('@b-current'), snapshottedElement);
  assert.equal(currentTarget('@b-current', '#stale'), null);
  snapshottedElement.isConnected = false;
  assert.equal(currentTarget('@b-current', '#continue'), null);
  assert.notEqual(currentTarget('@b-current', '#continue'), document.querySelector('#continue'));
});

test('agent pointer resolution uses live refs without requiring a selector, then snapshot x/y', () => {
  const start = source.indexOf('function resolveAgentPointer(request)');
  const end = source.indexOf('\nfunction inspectAuthenticationIntent', start);
  const scrolled = [];
  const liveTarget = {
    scrollIntoView: (options) => scrolled.push(options),
    getBoundingClientRect: () => ({ left: 8, top: 20, width: 40, height: 24 }),
  };
  const resolve = vm.runInNewContext(
    `(${source.slice(start, end).replace('function resolveAgentPointer', 'function')})`,
    {
      currentAgentSnapshotTarget: (ref, selector) =>
        ref === '@b-results' && (selector === undefined || selector === '#results')
          ? liveTarget
          : null,
      window: { innerWidth: 300, innerHeight: 200 },
    },
  );

  assert.deepEqual(resolve({ ref: '@b-results', x: 12.3, y: 45.8 }), { x: 28, y: 32 });
  assert.deepEqual(scrolled, [{ block: 'center', inline: 'center', behavior: 'auto' }]);
  assert.deepEqual(resolve({ x: 12.3, y: 45.8 }), { x: 12, y: 46 });
  assert.equal(resolve({ selector: '#missing', x: 12.3, y: 45.8 }), null);
});

test('ref-targeted scroll without a selector uses the live snapshot element', () => {
  const start = source.indexOf('function scrollTargetFor(request, horizontal)');
  const end = source.indexOf('\nfunction safeSnapshot()', start);
  class Element {}
  const nested = Object.assign(Object.create(Element.prototype), {
    parentElement: null,
    scrollWidth: 40,
    clientWidth: 40,
    scrollHeight: 800,
    clientHeight: 120,
  });
  const scrollTargetFor = vm.runInNewContext(
    `(${source.slice(start, end).replace('function scrollTargetFor', 'function')})`,
    {
      Element,
      currentAgentSnapshotTarget: (ref) => (ref === '@b-results' ? nested : null),
      requireCurrentAgentSnapshotTarget: () => {
        throw new Error('selector-less scroll must not require a selector');
      },
      document: {
        elementFromPoint: () => {
          throw new Error('live ref scroll must not fall back to viewport hit-testing');
        },
        scrollingElement: { id: 'document' },
        documentElement: { id: 'document' },
      },
      getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'auto' }),
    },
  );

  assert.equal(scrollTargetFor({ ref: '@b-results', x: 12, y: 46 }, false), nested);
});

test('OAuth authentication intent includes the exact authoritative anchor destination', () => {
  const start = source.indexOf('function inspectAuthenticationIntent(request)');
  const helperStart = source.indexOf('\nfunction authoritativeAuthenticationTarget', start);
  const end = source.indexOf('\nfunction sensitiveFocusedField', helperStart);
  class Element {}
  class HTMLIFrameElement extends Element {}
  class HTMLAnchorElement extends Element {}
  const realm = {
    URL,
    Element,
    HTMLIFrameElement,
    HTMLAnchorElement,
    cleanText: (value) => String(value || '').trim(),
    location: { href: 'https://app.example/login', origin: 'https://app.example' },
  };
  const anchor = new realm.HTMLAnchorElement();
  Object.assign(anchor, {
    href: 'https://accounts.example/authorize?client=droidex',
    target: '_blank',
    textContent: 'Continue with Google',
    value: '',
    form: null,
    closest: (selector) => (selector.includes('button') ? anchor : null),
    getAttribute: () => '',
  });
  realm.currentAgentSnapshotTarget = () => anchor;
  realm.document = { querySelector: () => anchor };
  realm.authoritativeAuthenticationTarget = vm.runInNewContext(
    `(${source
      .slice(helperStart + 1, end)
      .replace('function authoritativeAuthenticationTarget', 'function')})`,
    realm,
  );
  const inspect = vm.runInNewContext(
    `(${source
      .slice(start, helperStart)
      .replace('function inspectAuthenticationIntent', 'function')})`,
    realm,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(inspect({ action: 'click', ref: '@b-current', selector: '#oauth' }))),
    {
      kind: 'oauth',
      origin: 'https://app.example',
      label: 'Continue with Google',
      targetUrl: 'https://accounts.example/authorize?client=droidex',
    },
  );
});

test('browser snapshots stop scanning after a bounded number of DOM nodes', () => {
  const ceilingMatch = source.match(/const MAX_SNAPSHOT_VISITED_NODES = ([\d_]+);/);
  assert.ok(ceilingMatch, 'snapshot node ceiling must be explicit');
  const ceiling = Number(ceilingMatch[1].replaceAll('_', ''));
  assert.equal(ceiling, 2_000);

  const collectStart = source.indexOf('function collectRefs()');
  const collectEnd = source.indexOf('\nfunction intersectsViewport(', collectStart);
  assert.ok(collectStart >= 0 && collectEnd > collectStart);
  const collectSource = source.slice(collectStart, collectEnd);
  const nodes = Array.from({ length: ceiling * 2 }, () => ({}));
  let nextIndex = 1;
  let visited = 0;
  const collectRefs = vm.runInNewContext(
    `(${collectSource.replace('function collectRefs', 'function')})`,
    {
      MAX_SNAPSHOT_VISITED_NODES: ceiling,
      NodeFilter: { SHOW_ELEMENT: 1 },
      document: {
        body: nodes[0],
        documentElement: nodes[0],
        createTreeWalker() {
          return {
            nextNode() {
              return nodes[nextIndex++] ?? null;
            },
          };
        },
      },
      isCandidate() {
        visited += 1;
        return false;
      },
      refFor() {
        throw new Error('non-candidates must not be converted into refs');
      },
    },
  );

  assert.deepEqual(collectRefs(), []);
  assert.equal(visited, ceiling);
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The shipped preload is an esbuild bundle of electron/nativeBrowserPreload/;
// these tests exercise the source modules the functions actually live in.
const read = (module) =>
  fs.readFileSync(path.join(__dirname, 'nativeBrowserPreload', module), 'utf8');
const agentActions = read('agentActions.js');
const agentSnapshot = read('agentSnapshot.js');
const authIntent = read('authIntent.js');
const trustedNavigation = read('trustedNavigation.js');

test('trusted physical intent cannot expire before native navigation observes it', () => {
  const start = trustedNavigation.indexOf('function reportTrustedUserNavigation(event)');
  const end = trustedNavigation.indexOf('\nfunction trustedUserNavigationDestination', start);
  assert.ok(start >= 0 && end > start, 'trusted user navigation reporter must exist');
  const sent = [];
  let agentInputSuppressed = true;
  const report = vm.runInNewContext(
    `(${trustedNavigation.slice(start, end).replace('function reportTrustedUserNavigation', 'function')})`,
    {
      consumeTrustedPhysicalFormActivation: () => true,
      crypto: { randomUUID: () => 'activation-1' },
      ipcRenderer: { send: (...args) => sent.push(args) },
      isAgentInputSuppressed: () => agentInputSuppressed,
      state: { designMode: false, capturePending: false },
      trustedUserNavigationDestination: () => 'https://accounts.example/sign-in',
    },
  );

  report({ isTrusted: false });
  assert.deepEqual(sent, []);

  report({ isTrusted: true, type: 'click' });
  assert.deepEqual(sent, []);

  agentInputSuppressed = false;
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
});

test('a programmatic form submit cannot report user navigation without trusted physical input', () => {
  const start = trustedNavigation.indexOf('function reportTrustedUserNavigation(event)');
  const end = trustedNavigation.indexOf('\nfunction trustedUserNavigationDestination', start);
  const sent = [];
  const report = vm.runInNewContext(
    `(${trustedNavigation.slice(start, end).replace('function reportTrustedUserNavigation', 'function')})`,
    {
      consumeTrustedPhysicalFormActivation: () => false,
      crypto: { randomUUID: () => 'activation-2' },
      ipcRenderer: { send: (...args) => sent.push(args) },
      isAgentInputSuppressed: () => false,
      state: { designMode: false, capturePending: false },
      trustedUserNavigationDestination: () => 'https://accounts.example/sign-in',
    },
  );

  report({ isTrusted: true, type: 'submit', target: {} });
  assert.deepEqual(sent, []);
});

test('suppressed agent input cannot leave a trusted form activation behind', () => {
  const start = trustedNavigation.indexOf('function rememberTrustedPhysicalFormActivation(event)');
  const end = trustedNavigation.indexOf('\nfunction reportTrustedUserNavigation', start);
  assert.ok(start >= 0 && end > start, 'trusted form activation helpers must exist');
  let agentInputSuppressed = true;
  const activation = vm.runInNewContext(
    `(() => {
      let trustedPhysicalFormActivation = null;
      ${trustedNavigation.slice(start, end)}
      return { rememberTrustedPhysicalFormActivation, consumeTrustedPhysicalFormActivation };
    })()`,
    { isAgentInputSuppressed: () => agentInputSuppressed },
  );
  const form = {};
  const event = { isTrusted: true, type: 'pointerdown', button: 0, target: { form } };

  activation.rememberTrustedPhysicalFormActivation(event);
  agentInputSuppressed = false;
  assert.equal(activation.consumeTrustedPhysicalFormActivation(form), false);

  activation.rememberTrustedPhysicalFormActivation(event);
  assert.equal(activation.consumeTrustedPhysicalFormActivation(form), true);
});

test('trusted navigation destination accepts only real link and form defaults', () => {
  const start = trustedNavigation.indexOf('function trustedUserNavigationDestination(event)');
  // Stop at this function's own closing brace (a `}` in column 0) instead of at
  // end-of-file, so appending another function to the module stays valid here.
  const end = trustedNavigation.indexOf('\n}\n', start) + 2;
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
    `(${trustedNavigation
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

test('final page execution rejects a replaced document, snapshot, or in-page URL', () => {
  const start = agentSnapshot.indexOf('function requireCurrentAgentActionContext(expected)');
  const end = agentSnapshot.indexOf('\nfunction requireSafeAgentTextAction', start);
  const current = { documentId: 'document-1', snapshotId: 'document-1:8', urlHash: 'url-1' };
  const requireContext = vm.runInNewContext(
    `(${agentSnapshot
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
  const start = agentActions.indexOf('async function runAgentAction(request)');
  const end = agentActions.indexOf('\nfunction validateClickTargetAt', start);
  let agentSnapshotId = '';
  let contextChecks = 0;
  const runAction = vm.runInNewContext(
    `(${agentActions.slice(start, end).replace('async function runAgentAction', 'async function')})`,
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

test('agent input suppression stays fail-closed until its exact request ends', () => {
  const start = agentActions.indexOf('function beginAgentInputSuppression(requestId)');
  const end = agentActions.indexOf('\nasync function runAgentAction(request)', start);
  assert.ok(start >= 0 && end > start, 'agent input suppression helpers must exist');
  let now = 1_000;
  const suppression = vm.runInNewContext(
    `(() => {
      let agentInputSuppression = null;
      ${agentActions.slice(start, end)}
      return { beginAgentInputSuppression, endAgentInputSuppression, isAgentInputSuppressed };
    })()`,
    { Date: { now: () => now } },
  );

  suppression.beginAgentInputSuppression('request-1');
  assert.equal(suppression.isAgentInputSuppressed(), true);
  suppression.endAgentInputSuppression('request-2');
  assert.equal(suppression.isAgentInputSuppressed(), true);
  suppression.endAgentInputSuppression('request-1');
  assert.equal(suppression.isAgentInputSuppressed(), false);

  suppression.beginAgentInputSuppression('request-3');
  now += 10_001;
  assert.equal(suppression.isAgentInputSuppressed(), true);
});

test('native click preparation and completion own one suppression lease', async () => {
  const start = agentActions.indexOf('async function runAgentAction(request)');
  const end = agentActions.indexOf('\nfunction validateClickTargetAt', start);
  assert.ok(start >= 0 && end > start, 'native click action must use target validation');
  const calls = [];
  const runAction = vm.runInNewContext(
    `(${agentActions.slice(start, end).replace('async function runAgentAction', 'async function')})`,
    {
      beginAgentInputSuppression: (requestId) => calls.push(['begin', requestId]),
      endAgentInputSuppression: (requestId) => calls.push(['end', requestId]),
      pageSnapshot: () => ({ url: 'https://example.test/', refs: [] }),
      requireCurrentAgentActionContext: () => calls.push(['context']),
      requireCurrentAgentSnapshotTarget: () => ({ id: 'target' }),
      safeSnapshot: () => ({ refs: [] }),
      sendAgent: (result) => result,
      settle: async () => calls.push(['settle']),
      validateClickTargetAt: () => calls.push(['target']),
    },
  );

  const request = {
    requestId: 'request-click',
    action: 'click',
    ref: '@b-target',
    selector: '#target',
    x: 40,
    y: 60,
    __droidexContext: { documentId: 'document-1' },
  };
  const prepared = await runAction({ ...request, nativeInputPhase: 'prepare' });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {
    requestId: 'request-click',
    ok: true,
  });
  assert.deepEqual(calls, [['context'], ['target'], ['begin', 'request-click']]);

  calls.length = 0;
  const completed = await runAction({ ...request, nativeInputPhase: 'complete' });
  assert.equal(completed.ok, true);
  assert.equal(completed.snapshot.url, 'https://example.test/');
  assert.deepEqual(calls, [['end', 'request-click'], ['settle']]);

  calls.length = 0;
  const canceled = await runAction({ ...request, nativeInputPhase: 'cancel' });
  assert.deepEqual(JSON.parse(JSON.stringify(canceled)), {
    requestId: 'request-click',
    ok: true,
  });
  assert.deepEqual(calls, [['end', 'request-click']]);
});

test('hover validates the current target without dispatching a synthetic mouse event', async () => {
  const start = agentActions.indexOf('function validateHoverTargetAt(x, y, expectedTarget)');
  const end = agentActions.indexOf('\nfunction typeIntoFocused', start);
  const target = {
    dispatchCount: 0,
    dispatchEvent() {
      this.dispatchCount += 1;
    },
  };
  const hover = vm.runInNewContext(
    `(${agentActions.slice(start, end).replace('function validateHoverTargetAt', 'function')})`,
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
  const start = agentActions.indexOf('async function runAgentAction(request)');
  const end = agentActions.indexOf('\nfunction validateClickTargetAt', start);
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
    `(${agentActions.slice(start, end).replace('async function runAgentAction', 'async function')})`,
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

for (const action of ['click', 'hover']) {
  test(`ref-only ${action} rejects a different element at the leased coordinates`, async () => {
    class Element {}
    let inputCount = 0;
    const document = { elementFromPoint: () => hitTarget };
    const leasedTarget = Object.assign(new Element(), {
      isConnected: true,
      ownerDocument: document,
      contains: () => false,
      dispatchEvent: () => {
        inputCount += 1;
      },
    });
    let hitTarget = Object.assign(new Element(), {
      dispatchEvent: () => {
        inputCount += 1;
      },
    });
    const start = agentActions.indexOf('async function runAgentAction(request)');
    const end = agentActions.indexOf('\nfunction typeIntoFocused', start);
    const leaseStart = agentSnapshot.indexOf('function currentAgentSnapshotTarget(ref, selector)');
    const leaseEnd = agentSnapshot.indexOf('\nfunction invalidateAgentSnapshot', leaseStart);
    const runAction = vm.runInNewContext(
      `${agentActions.slice(start, end)}\n${agentSnapshot.slice(leaseStart, leaseEnd)}\nrunAgentAction`,
      {
        beginAgentInputSuppression: () => {},
        document,
        Element,
        MouseEvent: class {},
        agentSnapshotId: 'document:1',
        agentSnapshotTargets: new Map([
          ['@b-current', { element: leasedTarget, selector: '#target' }],
        ]),
        requireCurrentAgentActionContext: () => {},
        pageSnapshot: () => ({ refs: [] }),
        safeSnapshot: () => ({ refs: [] }),
        sendAgent: (result) => result,
        settle: async () => {},
      },
    );
    const request = {
      requestId: 'ref-only',
      action,
      ref: '@b-current',
      x: 40,
      y: 60,
      ...(action === 'click' ? { nativeInputPhase: 'prepare' } : {}),
    };
    const rejected = await runAction(request);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /target moved/);
    assert.equal(inputCount, 0);
    hitTarget = leasedTarget;
    assert.equal((await runAction(request)).ok, true);
    assert.equal(inputCount, 0);
  });
}

test('the isolated final action rechecks sensitive focus immediately before typing', () => {
  const start = agentSnapshot.indexOf('function requireSafeAgentTextAction(request)');
  const end = agentSnapshot.indexOf('\nfunction currentAgentSnapshotTarget', start);
  let sensitive = null;
  const requireSafeText = vm.runInNewContext(
    `(${agentSnapshot.slice(start, end).replace('function requireSafeAgentTextAction', 'function')})`,
    { sensitiveFocusedField: () => sensitive },
  );

  assert.doesNotThrow(() => requireSafeText({ action: 'type' }));
  sensitive = { kind: 'password' };
  assert.throws(() => requireSafeText({ action: 'type' }), /password field/);
  assert.throws(() => requireSafeText({ action: 'keypress', key: 'a' }), /password field/);
  assert.doesNotThrow(() => requireSafeText({ action: 'keypress', key: 'Enter' }));

  const actionStart = agentActions.indexOf('async function runAgentAction(request)');
  const actionEnd = agentActions.indexOf('\nfunction validateClickTargetAt', actionStart);
  const action = agentActions.slice(actionStart, actionEnd);
  assert.match(action, /requireSafeAgentTextAction\(request\);\s*typeIntoFocused/);
  assert.match(action, /requireSafeAgentTextAction\(request\);\s*pressKey/);
});

test('replacing an element with the same selector expires the old browser ref', () => {
  const start = agentSnapshot.indexOf('function currentAgentSnapshotTarget(ref, selector)');
  const end = agentSnapshot.indexOf('\nfunction requireCurrentAgentSnapshotTarget', start);
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
    `(${agentSnapshot.slice(start, end).replace('function currentAgentSnapshotTarget', 'function')})`,
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
  const start = agentActions.indexOf('function resolveAgentPointer(request)');
  const scrolled = [];
  const liveTarget = {
    scrollIntoView: (options) => scrolled.push(options),
    getBoundingClientRect: () => ({ left: 8, top: 20, width: 40, height: 24 }),
  };
  const resolve = vm.runInNewContext(
    `(${agentActions.slice(start).replace('function resolveAgentPointer', 'function')})`,
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
  assert.equal(resolve({ ref: '@b-missing', x: 12.3, y: 45.8 }), null);
});

test('ref-targeted scroll without a selector uses the live snapshot element', () => {
  const start = agentActions.indexOf('function scrollTargetFor(request, horizontal)');
  const end = agentActions.indexOf('\nfunction sendAgent', start);
  class Element {}
  const nested = Object.assign(Object.create(Element.prototype), {
    parentElement: null,
    scrollWidth: 40,
    clientWidth: 40,
    scrollHeight: 800,
    clientHeight: 120,
  });
  const scrollTargetFor = vm.runInNewContext(
    `(${agentActions.slice(start, end).replace('function scrollTargetFor', 'function')})`,
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
  const start = authIntent.indexOf('function inspectAuthenticationIntent(request)');
  const helperStart = authIntent.indexOf('\nfunction authoritativeAuthenticationTarget', start);
  class Element {}
  class HTMLIFrameElement extends Element {}
  class HTMLAnchorElement extends Element {}
  const realm = {
    URL,
    Element,
    HTMLIFrameElement,
    HTMLAnchorElement,
    cleanText: (value) => String(value || '').trim(),
    safeElementText: (element) => element.textContent || '',
    isSensitiveField: () => false,
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
    `(${authIntent
      .slice(helperStart + 1)
      .replace('function authoritativeAuthenticationTarget', 'function')})`,
    realm,
  );
  const inspect = vm.runInNewContext(
    `(${authIntent
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

test('focusing a credential field is not treated as submitting a sign-in form', () => {
  const start = authIntent.indexOf('function inspectAuthenticationIntent(request)');
  const end = authIntent.indexOf('\nfunction authoritativeAuthenticationTarget', start);
  class Element {
    constructor(tagName, type = '') {
      this.tagName = tagName;
      this.type = type;
    }

    matches(selector) {
      return selector.split(',').some((candidate) => {
        const value = candidate.trim();
        if (value === 'button') return this.tagName === 'BUTTON';
        if (value === 'a') return this.tagName === 'A';
        if (value === 'input') return this.tagName === 'INPUT';
        if (value === 'input[type="submit"]') {
          return this.tagName === 'INPUT' && this.type === 'submit';
        }
        if (value === 'input[type="button"]') {
          return this.tagName === 'INPUT' && this.type === 'button';
        }
        return false;
      });
    }

    closest(selector) {
      if (selector === 'form') return this.form;
      return this.matches(selector) ? this : null;
    }

    getAttribute(name) {
      return name === 'aria-label' ? 'Email' : '';
    }
  }
  class HTMLIFrameElement extends Element {}
  class HTMLAnchorElement extends Element {}
  const password = new Element('INPUT', 'password');
  const otp = new Element('INPUT', 'text');
  otp.autocomplete = 'one-time-code';
  const form = {
    textContent: 'Email Password',
    getAttribute: () => '',
    querySelectorAll: () => [password],
  };
  const username = new Element('INPUT', 'text');
  username.form = form;
  username.value = '';
  username.textContent = '';
  const inspect = vm.runInNewContext(
    `(${authIntent.slice(start, end).replace('function inspectAuthenticationIntent', 'function')})`,
    {
      Element,
      HTMLAnchorElement,
      HTMLIFrameElement,
      authoritativeAuthenticationTarget: () => null,
      cleanText: (value, limit) =>
        String(value || '')
          .trim()
          .slice(0, limit),
      currentAgentSnapshotTarget: () => username,
      editableFieldSelector: 'input,textarea,[contenteditable]',
      safeElementText: (element) => element.textContent || '',
      document: { activeElement: otp, elementFromPoint: () => username },
      isSensitiveField: (field) =>
        field.type === 'password' || field.autocomplete === 'one-time-code',
      location: { href: 'https://app.example/login', origin: 'https://app.example' },
      URL,
    },
  );

  assert.equal(inspect({ action: 'click', ref: '@b-email', selector: '#email' }), null);

  // A one-time-code form has no password input, but submitting it is still a sign-in.
  otp.form = { ...form, querySelectorAll: () => [otp] };
  assert.equal(inspect({ action: 'keypress', key: 'Enter' })?.kind, 'signin');
});

test('browser snapshots stop scanning after a bounded number of DOM nodes', () => {
  const ceilingMatch = agentSnapshot.match(/const MAX_SNAPSHOT_VISITED_NODES = ([\d_]+);/);
  assert.ok(ceilingMatch, 'snapshot node ceiling must be explicit');
  const ceiling = Number(ceilingMatch[1].replaceAll('_', ''));
  assert.equal(ceiling, 2_000);

  const collectStart = agentSnapshot.indexOf('function collectRefs()');
  const collectEnd = agentSnapshot.indexOf('\nfunction intersectsViewport(', collectStart);
  assert.ok(collectStart >= 0 && collectEnd > collectStart);
  const collectSource = agentSnapshot.slice(collectStart, collectEnd);
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

test('shipped preload bundle exposes exactly the documented main-world surface', () => {
  const bundlePath = path.join(__dirname, 'nativeBrowserPreload.cjs');
  if (!fs.existsSync(bundlePath)) {
    require('node:child_process').execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'tools', 'build-native-browser-preload.mjs')],
      { stdio: 'inherit' },
    );
  }
  const bundle = fs.readFileSync(bundlePath, 'utf8');

  // Sandboxed preloads can only require('electron'); a relative require would
  // resolve against the packaged asar at runtime and throw.
  const required = [...bundle.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(required)].sort(), ['electron']);

  // Every DOM object the bundle touches while loading answers to anything, so
  // the module's top-level effects run without a real renderer.
  const stub = () =>
    new Proxy(function () {}, {
      get: (_target, key) => (key === Symbol.toPrimitive || key === 'toString' ? () => '' : stub()),
      set: () => true,
      apply: () => stub(),
      construct: () => stub(),
    });
  const exposed = [];
  const subscribed = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (id) => {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name) => exposed.push(name) },
        ipcRenderer: { on: (channel) => subscribed.push(channel), send: () => {} },
      };
    },
    document: stub(),
    window: stub(),
    requestAnimationFrame: stub(),
    clearTimeout: stub(),
    crypto: stub(),
    location: stub(),
  };
  vm.runInNewContext(bundle, sandbox, { filename: 'nativeBrowserPreload.cjs' });

  assert.deepEqual(exposed.sort(), [
    '__DROIDMAXX_AGENT_ACTION',
    '__DROIDMAXX_AGENT_CONTEXT',
    '__DROIDMAXX_APPLY_DESIGN_STATE',
    '__DROIDMAXX_AUTH_INTENT',
    '__DROIDMAXX_FILL_CREDENTIALS',
    '__DROIDMAXX_MASK_SENSITIVE_FIELDS',
    '__DROIDMAXX_RESOLVE_POINTER',
    '__DROIDMAXX_SENSITIVE_FIELD',
  ]);
  assert.deepEqual(subscribed.sort(), [
    'native-browser-agent-snapshot-invalidated',
    'native-browser-design-prompt-sent',
  ]);

  const channels = [
    ...bundle.matchAll(/\bipcRenderer\.(?:send|invoke|on|once|sendSync)\(\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  assert.deepEqual([...new Set(channels)].sort(), [
    'native-browser-agent-snapshot-invalidated',
    'native-browser-credential-capture',
    'native-browser-design-prompt',
    'native-browser-design-prompt-sent',
    'native-browser-selection',
    'native-browser-user-navigation',
  ]);
});

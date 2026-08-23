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

test('browser inspection routes element text and HTML through sanitizers', () => {
  assert.match(source, /function safeElementText\(/);
  assert.equal(source.match(/cleanText\(el\.innerText \|\| el\.textContent/g)?.length, 1);
  assert.doesNotMatch(source, /html:\s*cleanText\(el\.outerHTML/);
  assert.match(source, /html:\s*cleanText\(sanitizedOuterHtml\(el\)/);
  assert.match(source, /redactedTextTags\.has\(el\.tagName\)/);
});

test('browser inspection covers URL-bearing and executable attributes', () => {
  for (const attribute of [
    'background',
    'cite',
    'data',
    'formaction',
    'itemid',
    'manifest',
    'poster',
    'usemap',
    'xlink:href',
  ]) {
    assert.match(source, new RegExp(`['"]${attribute}['"]`));
  }
  for (const attribute of ['ping', 'srcdoc', 'srcset', 'style']) {
    assert.match(source, new RegExp(`['"]${attribute}['"]`));
  }
  assert.match(source, /isMetaRefreshContent\(name, node\)/);
});

test('select option matching accepts the option label attribute', () => {
  assert.match(source, /cleanText\(item\.label\) === expected/);
});

test('remote pages cannot forge agent results and only expose bounded page operations', () => {
  assert.doesNotMatch(source, /native-browser-agent-result/);
  assert.match(source, /__DROIDMAXX_AGENT_ACTION/);
  assert.match(source, /__DROIDMAXX_AGENT_CONTEXT/);
  assert.match(source, /__DROIDMAXX_RESOLVE_POINTER/);
  assert.match(source, /__DROIDMAXX_AUTH_INTENT/);
  assert.match(source, /__DROIDMAXX_SENSITIVE_FIELD/);
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

test('agent pointer resolution runs in the isolated preload and rejects viewport edges', () => {
  const start = source.indexOf('function resolveAgentPointer(request)');
  const end = source.indexOf('\nfunction inspectAuthenticationIntent', start);
  const resolver = source.slice(start, end);

  assert.match(resolver, /currentAgentSnapshotTarget\(request\.ref, request\.selector\)/);
  assert.match(resolver, /target\.getBoundingClientRect\(\)/);
  assert.match(resolver, /point\.x >= window\.innerWidth/);
  assert.match(resolver, /point\.y >= window\.innerHeight/);
});

test('browser refs are leased to the exact snapshotted element', () => {
  assert.match(source, /const agentDocumentId = crypto\.randomUUID\(\)/);
  assert.match(source, /let agentSnapshotId = ''/);
  assert.match(source, /const agentSnapshotTargets = new Map\(\)/);
  assert.match(
    source,
    /agentSnapshotId = `\$\{agentDocumentId\}:\$\{String\(\+\+agentSnapshotSequence\)\}`/,
  );
  assert.match(source, /agentSnapshotTargets\.set\(ref, \{ element: el, selector \}\)/);
  assert.match(source, /function currentAgentSnapshotTarget\(ref, selector\)/);
  assert.match(source, /!target\.element\.isConnected/);
  assert.match(source, /target\.element\.ownerDocument !== document/);
  assert.match(source, /agentSnapshotTargets\.clear\(\)/);
  assert.match(source, /native-browser-agent-snapshot-invalidated[\s\S]*invalidateAgentSnapshot/);
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
  snapshottedElement.isConnected = false;
  assert.equal(currentTarget('@b-current', '#continue'), null);
  assert.notEqual(currentTarget('@b-current', '#continue'), document.querySelector('#continue'));
});

test('agent scroll resolves a live nested scroller and observes movement before snapshot', () => {
  const start = source.indexOf('function scrollPage(request)');
  const end = source.indexOf('\nfunction safeSnapshot', start);
  const scroll = source.slice(start, end);

  assert.match(scroll, /request\.selector/);
  assert.match(scroll, /requireCurrentAgentSnapshotTarget\(request\.ref, request\.selector\)/);
  assert.match(scroll, /scrollTargetFor/);
  assert.match(scroll, /target\.scrollBy/);
  assert.match(scroll, /before/);
  assert.match(source, /snapshot\.scrollResult = finishScrollAttempt\(scrollAttempt\)/);
});

test('browser snapshots prioritize live viewport refs before offscreen document refs', () => {
  const start = source.indexOf('function collectRefs()');
  const end = source.indexOf('\nfunction refFor', start);
  const collector = source.slice(start, end);

  assert.match(collector, /const visible = \[\]/);
  assert.match(collector, /const offscreen = \[\]/);
  assert.match(collector, /intersectsViewport\(node\.getBoundingClientRect\(\)\)/);
  assert.match(collector, /return \[\.\.\.visible, \.\.\.offscreen\]\.slice\(0, 80\)/);
});

test('agent cursor is not exposed to remote page JavaScript', () => {
  assert.doesNotMatch(source, /function showAgentCursor\(/);
  assert.doesNotMatch(source, /__DROIDMAXX_SHOW_AGENT_CURSOR/);
});

test('screenshot masking is available inside the isolated page world', () => {
  assert.match(source, /function maskSensitiveFields\(/);
  assert.match(source, /__DROIDMAXX_MASK_SENSITIVE_FIELDS/);
  assert.match(source, /one-time-code/);
});

test('saved-login screenshots mask both vault-populated fields', () => {
  const fillStart = source.indexOf('function fillCredentials(payload)');
  const fillEnd = source.indexOf('\nfunction inspectAuthenticationIntent', fillStart);
  const fill = source.slice(fillStart, fillEnd);
  const maskStart = source.indexOf('function maskSensitiveFields(active)');
  const maskEnd = source.indexOf('\nfunction usernameFieldFor', maskStart);
  const mask = source.slice(maskStart, maskEnd);

  assert.match(source, /const savedCredentialFields = new WeakSet\(\)/);
  assert.match(fill, /savedCredentialFields\.add\(userField\)[\s\S]*?setFieldValue\(userField/);
  assert.match(
    fill,
    /savedCredentialFields\.add\(passwordField\)[\s\S]*?setFieldValue\(passwordField/,
  );
  assert.match(mask, /if \(!isSensitiveField\(field\)\) continue/);
  assert.match(source, /if \(savedCredentialFields\.has\(el\)\) return true/);
});

test('OAuth callback URLs redact replayable state and assertion parameters', () => {
  for (const key of ['state', 'nonce', 'relaystate', 'assertion', 'ticket', 'samlresponse']) {
    assert.match(source, new RegExp(`['"]${key}['"]`));
  }
  assert.match(source, /redactBrowserDiagnosticUrl\(location\.href\)/);
});

test('credential capture classifies current and new-password forms without blocking submit', () => {
  assert.match(source, /document\.addEventListener\('submit', onFormSubmit, true\)/);
  assert.match(source, /current_password/);
  assert.match(source, /new_password/);
  const start = source.indexOf('function onFormSubmit(event)');
  const end = source.indexOf('\nfunction fillCredentials', start);
  assert.doesNotMatch(source.slice(start, end), /preventDefault/);
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

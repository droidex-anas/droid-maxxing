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
  assert.match(source, /__DROIDMAXX_RESOLVE_POINTER/);
  assert.match(source, /__DROIDMAXX_AUTH_INTENT/);
  assert.match(source, /__DROIDMAXX_SENSITIVE_FIELD/);
});

test('agent pointer resolution runs in the isolated preload and rejects viewport edges', () => {
  const start = source.indexOf('function resolveAgentPointer(request)');
  const end = source.indexOf('\nfunction inspectAuthenticationIntent', start);
  const resolver = source.slice(start, end);

  assert.match(resolver, /document\.querySelector\(request\.selector\)/);
  assert.match(resolver, /target\.getBoundingClientRect\(\)/);
  assert.match(resolver, /point\.x >= window\.innerWidth/);
  assert.match(resolver, /point\.y >= window\.innerHeight/);
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

  assert.deepEqual(JSON.parse(JSON.stringify(inspect({ action: 'click', selector: '#oauth' }))), {
    kind: 'oauth',
    origin: 'https://app.example',
    label: 'Continue with Google',
    targetUrl: 'https://accounts.example/authorize?client=droidex',
  });
});

test('browser snapshots stop scanning after a bounded number of DOM nodes', () => {
  const ceilingMatch = source.match(/const MAX_SNAPSHOT_VISITED_NODES = ([\d_]+);/);
  assert.ok(ceilingMatch, 'snapshot node ceiling must be explicit');
  const ceiling = Number(ceilingMatch[1].replaceAll('_', ''));
  assert.equal(ceiling, 2_000);

  const collectStart = source.indexOf('function collectRefs()');
  const collectEnd = source.indexOf('\nfunction refFor(', collectStart);
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

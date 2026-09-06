const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserPageEvents } = require('./nativeBrowserPageEvents.cjs');

function fixture(capture = async () => 'masked-image') {
  const sender = { mainFrame: { url: 'https://example.test/' }, isDestroyed: () => false };
  const entry = { browserSessionId: 'browser-1', view: {}, documentGeneration: 1 };
  const calls = [];
  const events = createNativeBrowserPageEvents({
    findEntryForContents: (contents) => (contents === sender ? entry : undefined),
    page: { captureDesignSelection: capture },
    credentials: { capture: (...args) => calls.push(args) },
    navigation: {
      recordTrustedUserNavigation: (...args) => calls.push(args),
      expireTrustedUserNavigation: (...args) => calls.push(args),
    },
  });
  return { entry, sender, events, calls, event: { sender, senderFrame: sender.mainFrame } };
}

test('page IPC rejects subframes before credentials, navigation, or design capture', async () => {
  const f = fixture(() => assert.fail('subframe must not capture'));
  const event = { ...f.event, senderFrame: { url: 'https://example.test/frame' } };
  assert.equal(f.events.selectionForEvent(event, {}), undefined);
  assert.equal(await f.events.prepareDesignPrompt(event, { selection: {} }), undefined);
  f.events.recordUserNavigation(event, {});
  f.events.expireUserNavigation(event, {});
  await f.events.captureCredential(event, {});
  assert.deepEqual(f.calls, []);
});

test('design prompt binds selection identity and uses only the masked capture', async () => {
  const f = fixture();
  assert.deepEqual(
    await f.events.prepareDesignPrompt(f.event, {
      prompt: 'Change color',
      selection: { selector: '#button', browserSessionId: 'spoof' },
    }),
    {
      prompt: 'Change color',
      selection: { selector: '#button', browserSessionId: 'browser-1', screenshot: 'masked-image' },
    },
  );
});

for (const change of ['document', 'view']) {
  test(`design prompt drops capture if ${change} changes while capture is pending`, async () => {
    let resolve;
    const f = fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.events.prepareDesignPrompt(f.event, { selection: { selector: '#old' } });
    if (change === 'document') f.entry.documentGeneration += 1;
    else f.entry.view = {};
    resolve('obsolete-image');
    assert.equal(await pending, undefined);
  });
}

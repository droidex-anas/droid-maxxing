import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { BrowserNativeResult } from '../../src/types/bridge';

declare global {
  interface Window {
    __DROIDMAXX_AGENT_ACTION: (request: Record<string, unknown>) => Promise<BrowserNativeResult>;
    __DROIDMAXX_AGENT_CONTEXT: () => unknown;
    __DROIDMAXX_APPLY_DESIGN_STATE: (state: { designMode: boolean }) => void;
    __DROIDMAXX_AUTH_INTENT: (request: Record<string, unknown>) => unknown;
    __DROIDMAXX_MASK_SENSITIVE_FIELDS: (active: boolean) => boolean;
    __DROIDMAXX_SENSITIVE_FIELD: () => { kind: string } | null;
  }
}

let bundle: string;

test.beforeAll(() => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../tools/build-native-browser-preload.mjs', import.meta.url)),
  ]);
  bundle = readFileSync(
    new URL('../../electron/nativeBrowserPreload.cjs', import.meta.url),
    'utf8',
  );
});

test.beforeEach(async ({ page }) => {
  await page.route('https://preload.example/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>',
    }),
  );
  await page.goto('https://preload.example/');
  await page.evaluate((source) => {
    const selections: unknown[] = [];
    Reflect.set(window, 'preloadSelections', selections);
    const electron = {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => Reflect.set(window, name, value),
      },
      ipcRenderer: {
        on: () => undefined,
        send: (channel: string, payload: unknown) => {
          if (channel === 'native-browser-selection') selections.push(payload);
        },
      },
    };
    new Function('require', source)((name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
      return electron;
    });
  }, bundle);
});

test('editable text stays out of snapshots and details, and sensitive fields stay masked', async ({
  page,
}) => {
  await page.locator('body').evaluate(
    (body, html) => {
      body.innerHTML = html;
    },
    `
    <form id="form">
      <p>Public page copy</p>
      <textarea id="otp" autocomplete="one-time-code">private-textarea-code</textarea>
      <div id="passcode" contenteditable="true">
        <span style="color:red;visibility:visible">private-editable-code</span>
      </div>
      <textarea id="notes">private-ordinary-notes</textarea>
      <div id="editor" contenteditable>
        private-editor-text<span>private-nested-text</span>
      </div>
      <div id="plain" contenteditable="plaintext-only">private-plain-text</div>
      <button type="submit">Continue</button>
    </form>
  `,
  );
  const payloads = await page.evaluate(async () => {
    const snapshot = await window.__DROIDMAXX_AGENT_ACTION({ action: 'snapshot' });
    const inspections = [];
    for (const selector of [
      '#otp',
      '#passcode',
      '#passcode span',
      '#notes',
      '#editor',
      '#editor span',
      '#plain',
      '#form',
    ]) {
      inspections.push(
        await window.__DROIDMAXX_AGENT_ACTION({
          action: 'inspect',
          selector,
          __droidexContext: window.__DROIDMAXX_AGENT_CONTEXT(),
        }),
      );
    }
    document.querySelector<HTMLTextAreaElement>('#otp')?.focus();
    const intent = window.__DROIDMAXX_AUTH_INTENT({ action: 'keypress', key: 'Enter' });
    return { snapshot, inspections, intent };
  });
  expect(payloads.snapshot.ok).toBe(true);
  expect(payloads.inspections.every((result) => result.ok)).toBe(true);
  expect(payloads.intent).toMatchObject({ kind: 'signin' });
  expect(JSON.stringify(payloads)).not.toContain('private-');
  expect(JSON.stringify(payloads)).toContain('Public page copy');
  expect(JSON.stringify(payloads)).toContain('[redacted]');
  for (const result of payloads.inspections.slice(0, -1)) {
    expect(result.inspection).toMatchObject({ text: '[redacted]', name: '[redacted]' });
  }
  await expect(page.locator('#notes')).toHaveValue('private-ordinary-notes');
  await expect(page.locator('#editor span')).toHaveText('private-nested-text');

  const before = await page.locator('#passcode span').getAttribute('style');
  await page.evaluate(() => window.__DROIDMAXX_MASK_SENSITIVE_FIELDS(true));
  await expect(page.locator('#otp')).toBeHidden();
  await expect(page.locator('#passcode span')).toBeHidden();
  await page.evaluate(() => window.__DROIDMAXX_MASK_SENSITIVE_FIELDS(false));
  await expect(page.locator('#otp')).toBeVisible();
  await expect(page.locator('#passcode span')).toBeVisible();
  await expect(page.locator('#otp')).toHaveValue('private-textarea-code');
  await expect(page.locator('#passcode span')).toHaveAttribute('style', before ?? '');
});

test('design text selection omits editor text but accepts noneditable public copy', async ({
  page,
}) => {
  await page.locator('body').evaluate((body) => {
    body.innerHTML = `
      <div contenteditable><span id="notes">Private editor text</span></div>
      <p contenteditable="false"><span id="public">Public page copy</span></p>
    `;
  });
  await page.evaluate(() => window.__DROIDMAXX_APPLY_DESIGN_STATE({ designMode: true }));
  for (const id of ['notes', 'public']) {
    const box = await page.locator(`#${id}`).boundingBox();
    if (!box) throw new Error('Missing text selection target');
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const selections = await page.evaluate(() => Reflect.get(window, 'preloadSelections'));
    if (id === 'notes') expect(selections).toEqual([]);
    else expect(selections).toMatchObject([{ anchor: { kind: 'text', text: 'Public page copy' } }]);
  }
});

test('agent keypresses are blocked through lowercase XHTML frames and fields', async ({ page }) => {
  await page.route('https://preload.example/xhtml-frame', (route) =>
    route.fulfill({
      contentType: 'application/xhtml+xml',
      body: `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <iframe src="https://preload.example/xhtml-form"></iframe>
      </body></html>`,
    }),
  );
  await page.route('https://preload.example/xhtml-form', (route) =>
    route.fulfill({
      contentType: 'application/xhtml+xml',
      body: `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <input id="password" type="password" value="unchanged" />
        <textarea id="code" autocomplete="one-time-code">unchanged</textarea>
      </body></html>`,
    }),
  );
  const formLoaded = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame.url() === 'https://preload.example/xhtml-form',
  });
  await page.locator('body').evaluate((body) => {
    const frame = document.createElement('iframe');
    frame.src = 'https://preload.example/xhtml-frame';
    body.appendChild(frame);
  });
  const frame = await formLoaded;
  for (const [id, kind] of [
    ['password', 'password'],
    ['code', 'one-time code'],
  ]) {
    const field = frame.locator(`#${id}`);
    await field.focus();
    const result = await page.evaluate(async () => {
      await window.__DROIDMAXX_AGENT_ACTION({ action: 'snapshot' });
      return window.__DROIDMAXX_AGENT_ACTION({
        action: 'keypress',
        key: 'x',
        __droidexContext: window.__DROIDMAXX_AGENT_CONTEXT(),
      });
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`will not send agent-authored text into a ${kind}`);
    expect(await field.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => el.value)).toBe(
      'unchanged',
    );
  }
});

for (const crossOrigin of [false, true]) {
  test(`agent text is blocked in nested ${crossOrigin ? 'cross-origin' : 'same-origin'} sensitive frames`, async ({
    page,
  }) => {
    const url = crossOrigin ? 'https://foreign.example/form' : 'https://preload.example/form';
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `
          <input id="password" type="password" value="unchanged">
          <input id="code" autocomplete="one-time-code" value="unchanged">
          <input id="ordinary" value="unchanged">
        `,
      }),
    );
    await page.locator('body').evaluate((body, url) => {
      const outer = document.createElement('iframe');
      outer.srcdoc = `<iframe src="${url}"></iframe>`;
      body.appendChild(outer);
    }, url);
    const frame = page.frameLocator('iframe').frameLocator('iframe');
    for (const [id, kind] of [
      ['password', 'password'],
      ['code', 'one-time code'],
      ['ordinary', null],
    ]) {
      const field = frame.locator(`#${id}`);
      await field.focus();
      const expectedKind = crossOrigin ? 'protected frame' : kind;
      expect(await page.evaluate(() => window.__DROIDMAXX_SENSITIVE_FIELD())).toEqual(
        expectedKind ? { kind: expectedKind } : null,
      );
      for (const action of ['type', 'keypress']) {
        const result = await page.evaluate(async (action) => {
          await window.__DROIDMAXX_AGENT_ACTION({ action: 'snapshot' });
          return window.__DROIDMAXX_AGENT_ACTION({
            action,
            text: 'x',
            key: 'x',
            __droidexContext: window.__DROIDMAXX_AGENT_CONTEXT(),
          });
        }, action);
        if (expectedKind) {
          expect(result.ok).toBe(false);
          expect(result.error).toContain(
            `will not send agent-authored text into a ${expectedKind}`,
          );
        } else if (action === 'keypress') {
          expect(result.ok).toBe(true);
        }
        await expect(field).toHaveValue('unchanged');
      }
    }
  });
}

test('typing rejects noneditable controls without mutating values or firing input events', async ({
  page,
}) => {
  await page.locator('body').evaluate(
    (body, html) => {
      body.innerHTML = html;
    },
    `
    <input id="checkbox" type="checkbox" value="unchanged">
    <input id="button" type="button" value="unchanged">
    <input id="readonly" readonly value="unchanged">
    <input id="email" type="email">
  `,
  );
  for (const id of ['checkbox', 'button', 'readonly', 'email']) {
    const result = await page.evaluate(async (id) => {
      const input = document.querySelector<HTMLInputElement>(`#${id}`);
      if (!input) throw new Error('Missing test control');
      input.focus();
      await window.__DROIDMAXX_AGENT_ACTION({ action: 'snapshot' });
      let events = 0;
      input.addEventListener('input', () => events++);
      input.addEventListener('change', () => events++);
      const response = await window.__DROIDMAXX_AGENT_ACTION({
        action: 'type',
        text: 'public@example.test',
        __droidexContext: window.__DROIDMAXX_AGENT_CONTEXT(),
      });
      return { response, value: input.value, events };
    }, id);
    if (id === 'email') {
      expect(result.response.ok).toBe(true);
      expect(result.value).toBe('public@example.test');
      expect(result.events).toBe(2);
    } else {
      expect(result.response.ok).toBe(false);
      expect(result.response.error).toContain('not text-editable');
      expect(result.value).toBe('unchanged');
      expect(result.events).toBe(0);
    }
  }
});

test('the design composer accepts typing and Escape while page keyboard scrolling stays blocked', async ({
  page,
  context,
}) => {
  await page.locator('body').evaluate((body) => {
    body.innerHTML = '<button>Pick this element</button><div style="height:3000px"></div>';
  });
  await page.evaluate(() => window.__DROIDMAXX_APPLY_DESIGN_STATE({ designMode: true }));
  await page.getByRole('button', { name: 'Pick this element' }).click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-droid-design')))
    .toBe('1');
  const cdp = await context.newCDPSession(page);
  const host = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' });
  const { node } = await cdp.send('DOM.describeNode', {
    objectId: host.result.objectId,
    depth: 1,
    pierce: true,
  });
  const shadowRoot = node.shadowRoots?.[0];
  if (!shadowRoot) throw new Error('The design composer did not receive focus.');
  const root = await cdp.send('DOM.resolveNode', { backendNodeId: shadowRoot.backendNodeId });
  const composerState = async () => {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: root.object.objectId,
      functionDeclaration: `function() {
        const input = this.querySelector('input');
        return { value: input.value, focused: this.activeElement === input,
          display: input.closest('form').style.display };
      }`,
      returnByValue: true,
    });
    return result.value;
  };
  expect(await composerState()).toMatchObject({ focused: true, display: 'block' });
  await page.keyboard.type('Make this clearer');
  expect(await composerState()).toMatchObject({ value: 'Make this clearer' });
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus({ preventScroll: true });
  });
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('PageDown');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await cdp.send('Runtime.callFunctionOn', {
    objectId: root.object.objectId,
    functionDeclaration: "function() { this.querySelector('input').focus(); }",
  });
  await page.keyboard.press('Escape');
  expect(await composerState()).toMatchObject({ display: 'none' });
  await cdp.detach();
});

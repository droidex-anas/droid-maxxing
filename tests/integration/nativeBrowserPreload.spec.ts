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
    const electron = {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => Reflect.set(window, name, value),
      },
      ipcRenderer: { on: () => undefined, send: () => undefined },
    };
    new Function('require', source)((name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
      return electron;
    });
  }, bundle);
});

test('sensitive editable text stays out of snapshots, details, auth prompts, and captures', async ({
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
      <button type="submit">Continue</button>
    </form>
  `,
  );
  const payloads = await page.evaluate(async () => {
    const snapshot = await window.__DROIDMAXX_AGENT_ACTION({ action: 'snapshot' });
    const inspections = [];
    for (const selector of ['#otp', '#passcode', '#passcode span', '#form']) {
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
  expect(JSON.stringify(payloads)).not.toMatch(/private-textarea-code|private-editable-code/);
  expect(JSON.stringify(payloads)).toContain('Public page copy');
  expect(JSON.stringify(payloads)).toContain('[redacted]');

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

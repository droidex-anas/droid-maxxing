import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserMcpServer } from './browserMcpServer.js';
import { browserMcpToolNames } from './browserMcpToolDefs.js';
import type { BrowserSessionManager } from './BrowserSessionManager.js';

test('browser MCP server exposes agent-facing names and typed inputs', () => {
  const server = createBrowserMcpServer({} as BrowserSessionManager, () => 'm1');
  const registeredNames = server.tools.map((tool) => tool.name);

  assert.equal(server.name, 'droidex-browser');
  assert.deepEqual(registeredNames, [
    'open',
    'snapshot',
    'reload',
    'back',
    'forward',
    'screenshot',
    'click',
    'hover',
    'select',
    'type',
    'keypress',
    'resize',
    'scroll',
    'wait',
    'inspect',
    'network',
    'console',
    'fill_login',
    'design_context',
    'design_reference',
  ]);
  assert.deepEqual([...browserMcpToolNames()], registeredNames);
  assert.ok(server.tools.find((tool) => tool.name === 'open')?.inputSchema?.url);
  assert.ok(
    server.tools.find((tool) => tool.name === 'screenshot')?.inputSchema?.deviceScaleFactor,
  );
  assert.match(
    server.tools.find((tool) => tool.name === 'open')?.description ?? '',
    /Do not ask the user for a URL/,
  );
  assert.match(
    server.tools.find((tool) => tool.name === 'open')?.description ?? '',
    /Never reopen a URL from conversation memory/,
  );
  assert.match(
    server.tools.find((tool) => tool.name === 'snapshot')?.description ?? '',
    /current or already-open browser/,
  );
  const reloadDescription = server.tools.find((tool) => tool.name === 'reload')?.description ?? '';
  assert.match(reloadDescription, /already includes fresh page refs/);
  assert.doesNotMatch(reloadDescription, /Use snapshot after reload/);
  const scrollDescription = server.tools.find((tool) => tool.name === 'scroll')?.description ?? '';
  assert.match(scrollDescription, /already includes fresh page refs/);
  assert.doesNotMatch(scrollDescription, /call snapshot to refresh refs/);
});

test('browser MCP handlers return visible tool errors', async () => {
  const manager = {
    async refresh() {
      throw new Error('Browser session is not open yet.');
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const designMode = server.tools.find((tool) => tool.name === 'design_context');

  const result = await designMode?.handler({});

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(result), /Browser session is not open yet/);
});

test('cached Design Mode data is read only after main browser policy authorizes access', async () => {
  const calls: string[] = [];
  const state = {
    url: 'https://example.com',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    viewportMode: 'fit' as const,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
  const manager = {
    async refresh(appSessionId: string) {
      calls.push(`authorize:${appSessionId}`);
      return state;
    },
    designContext(appSessionId: string) {
      calls.push(`context:${appSessionId}`);
      return { state, references: [] };
    },
    referenceDetail(appSessionId: string, id: string) {
      calls.push(`reference:${appSessionId}:${id}`);
      return undefined;
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');

  await server.tools.find((tool) => tool.name === 'design_context')?.handler({});
  await server.tools.find((tool) => tool.name === 'design_reference')?.handler({ id: '@live-1' });

  assert.deepEqual(calls, ['authorize:m1', 'context:m1', 'authorize:m1', 'reference:m1:@live-1']);
});

test('design_context caps returned screenshots and reports the omitted ones', async () => {
  const state = {
    url: 'https://example.com',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    viewportMode: 'fit' as const,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
  const references = Array.from({ length: 6 }, (_, index) => ({
    id: `@live-${index}`,
    anchor: { id: `@live-${index}`, kind: 'element', label: 'Save', box: box() },
    url: state.url,
    viewport: state.viewport,
    scroll: state.scroll,
    screenshot: { base64: `image-${index}`, box: box() },
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const manager = {
    async refresh() {
      return state;
    },
    designContext() {
      return { state, references };
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');

  const result = (await server.tools
    .find((tool) => tool.name === 'design_context')
    ?.handler({})) as {
    content: { type: string; data?: string }[];
  };
  const images = result.content.filter((block) => block.type === 'image');

  assert.deepEqual(
    images.map((block) => block.data),
    ['image-2', 'image-3', 'image-4', 'image-5'],
  );
  assert.match(JSON.stringify(result.content[0]), /omittedScreenshots.{0,4}2/);
});

function box() {
  return { x: 0, y: 0, width: 10, height: 10 };
}

test('open keeps high-detail viewport scale by default', async () => {
  let openedViewport: { width: number; height: number; deviceScaleFactor?: number } | undefined;
  const manager = {
    async open(input: {
      viewport?: { width: number; height: number; deviceScaleFactor?: number };
    }) {
      openedViewport = input.viewport;
      return {
        url: 'https://example.com',
        viewport: input.viewport,
        viewportMode: 'custom',
        scroll: { x: 0, y: 0 },
        refs: [],
      };
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const browserOpen = server.tools.find((tool) => tool.name === 'open');

  const result = await browserOpen?.handler({
    url: 'https://example.com',
    viewport: { width: 1000, height: 700 },
    viewportMode: 'custom',
  });

  assert.equal(openedViewport?.deviceScaleFactor, 2);
  assert.match(String(result), /Opened the live DROIDEX browser/);
});

test('reload returns a fresh browser state', async () => {
  const manager = {
    async reload() {
      return {
        url: 'https://example.com',
        viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
        viewportMode: 'fit',
        scroll: { x: 0, y: 0 },
        refs: [],
      };
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const browserReload = server.tools.find((tool) => tool.name === 'reload');

  const result = await browserReload?.handler({});

  assert.match(String(result), /https:\/\/example.com/);
});

test('browser history tools return the resulting page state', async () => {
  const calls: string[] = [];
  const state = {
    url: 'https://example.com/history',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    viewportMode: 'fit' as const,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
  const manager = {
    async goBack() {
      calls.push('back');
      return state;
    },
    async goForward() {
      calls.push('forward');
      return state;
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');

  await server.tools.find((tool) => tool.name === 'back')?.handler({});
  await server.tools.find((tool) => tool.name === 'forward')?.handler({});

  assert.deepEqual(calls, ['back', 'forward']);
});

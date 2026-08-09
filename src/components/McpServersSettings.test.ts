import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { McpServerInfo, McpStatusSummary, McpToolInfo } from '../types/bridge.js';
import { McpServersSection } from './McpServersSettings.js';

const summary: McpStatusSummary = {
  total: 2,
  connected: 1,
  connecting: 0,
  failed: 0,
  disabled: 1,
};

const servers: McpServerInfo[] = [
  {
    name: 'sentry',
    status: 'connected',
    source: 'user',
    isManaged: false,
    serverType: 'http',
    toolCount: 1,
    hasAuthTokens: true,
  },
  {
    name: 'team-db',
    status: 'disabled',
    source: 'project',
    isManaged: false,
    serverType: 'stdio',
  },
];

const tools: McpToolInfo[] = [
  {
    serverName: 'sentry',
    name: 'search_issues',
    description: 'Search issues',
    isEnabled: true,
    isReadOnly: true,
  },
];

function render(overrides: Partial<Parameters<typeof McpServersSection>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(McpServersSection, {
      servers,
      tools,
      summary,
      isLoading: false,
      isMutating: false,
      error: undefined,
      onRefresh: () => undefined,
      onAdd: () => undefined,
      onRemove: () => undefined,
      onToggle: () => undefined,
      onAuthenticate: () => undefined,
      ...overrides,
    }),
  );
}

test('MCP settings exposes Droid status, scope, tool counts, and add controls', () => {
  const html = render();

  assert.match(html, /MCP servers/);
  assert.match(html, /1 connected/);
  assert.match(html, /sentry/);
  assert.match(html, /User/);
  assert.match(html, /1 tool/);
  assert.doesNotMatch(html, /search_issues/);
  assert.match(html, /team-db/);
  assert.match(html, /Project/);
  assert.match(html, /Add server/);
});

test('only user-owned MCP servers expose removal', () => {
  const html = render();
  const sentry = html.slice(html.indexOf('sentry'), html.indexOf('team-db'));
  const project = html.slice(html.indexOf('team-db'));

  assert.match(sentry, /Remove/);
  assert.match(sentry, /aria-label="Remove sentry"/);
  assert.doesNotMatch(project, /Remove/);
});

test('MCP settings uses the standard UI font', () => {
  assert.doesNotMatch(render(), /font-mono/);
});

test('MCP settings has honest loading, failure, and empty states', () => {
  assert.match(render({ isLoading: true, servers: [], tools: [] }), /Loading MCP servers/);
  assert.match(render({ error: 'Droid is unavailable' }), /Droid is unavailable/);
  assert.match(
    render({
      servers: [],
      tools: [],
      summary: { ...summary, total: 0, connected: 0, disabled: 0 },
    }),
    /No MCP servers configured/,
  );
});

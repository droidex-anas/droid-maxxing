import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerStatus, McpServerType, SettingsLevel } from '@factory/droid-sdk';

import { McpSettings } from './McpSettings.js';
import type { ClientCommand, ServerEvent } from './protocol.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

function command(value: unknown): ClientCommand {
  return value as ClientCommand;
}

function mcpCatalog(events: ServerEvent[]): Record<string, unknown> | undefined {
  return events.find((event) => (event as { type: string }).type === 'mcp.catalog') as
    | Record<string, unknown>
    | undefined;
}

test('MCP catalog comes from Droid with effective scope, status, and tools', async () => {
  const h = createSessionManagerTestContext();
  const session = new FakeFactorySession('mcp-catalog', {}, h.calls);
  session.nextMcpServers = {
    servers: [
      {
        name: 'sentry',
        status: McpServerStatus.Connected,
        source: SettingsLevel.User,
        isManaged: false,
        serverType: McpServerType.Http,
        hasAuthTokens: true,
        toolCount: 2,
      },
    ],
    summary: { total: 1, connected: 1, connecting: 0, failed: 0, disabled: 0 },
  };
  session.nextMcpTools = {
    tools: [
      {
        serverName: 'sentry',
        name: 'search_issues',
        description: 'Search Sentry issues',
        isEnabled: true,
        isReadOnly: true,
      },
    ],
  };
  h.runtime.createQueue.push(session);

  try {
    await h.handle(command({ type: 'mcp.list', requestId: 'list-1', cwd: '/workspace/project' }));

    assert.equal(h.runtime.createCalls[0]?.cwd, '/workspace/project');
    assert.deepEqual(mcpCatalog(h.events), {
      type: 'mcp.catalog',
      requestId: 'list-1',
      cwd: '/workspace/project',
      servers: session.nextMcpServers.servers,
      tools: session.nextMcpTools.tools,
      summary: session.nextMcpServers.summary,
    });
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'mcp-catalog',
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test('adding an MCP server uses Droid user configuration and returns a refreshed catalog', async () => {
  const h = createSessionManagerTestContext();
  const session = new FakeFactorySession('mcp-add', {}, h.calls);
  h.runtime.createQueue.push(session);

  try {
    await h.handle(
      command({
        type: 'mcp.add',
        requestId: 'add-1',
        cwd: '/workspace/project',
        server: {
          name: 'linear',
          serverType: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      }),
    );

    assert.deepEqual(
      h.calls.find((call) => call.target === 'runtime' && call.method === 'mcp.addConfigured')
        ?.args,
      [
        {
          name: 'linear',
          serverType: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
        '/workspace/project',
      ],
    );
    assert.equal(mcpCatalog(h.events)?.requestId, 'add-1');
  } finally {
    await h.dispose();
  }
});

test('MCP catalog publishes tools after a connecting server settles', async () => {
  const calls: ConstructorParameters<typeof FakeFactorySession>[2] = [];
  const session = new FakeFactorySession('mcp-settle', {}, calls);
  session.nextMcpServers = {
    servers: [
      {
        name: 'local-tools',
        status: McpServerStatus.Connecting,
        source: SettingsLevel.User,
        isManaged: false,
        serverType: McpServerType.Stdio,
      },
    ],
    summary: { total: 1, connected: 0, connecting: 1, failed: 0, disabled: 0 },
  };
  const events: ServerEvent[] = [];
  const settings = new McpSettings(
    async () => session,
    { add: async () => undefined, remove: async () => undefined },
    (event) => events.push(event),
    async () => {
      session.nextMcpServers = {
        servers: [
          {
            name: 'local-tools',
            status: McpServerStatus.Connected,
            source: SettingsLevel.User,
            isManaged: false,
            serverType: McpServerType.Stdio,
            toolCount: 1,
          },
        ],
        summary: { total: 1, connected: 1, connecting: 0, failed: 0, disabled: 0 },
      };
      session.nextMcpTools = {
        tools: [
          {
            serverName: 'local-tools',
            name: 'echo',
            isEnabled: true,
          },
        ],
      };
    },
  );

  await settings.handle({ type: 'mcp.list', requestId: 'settle-1' });

  const catalogs = events.filter((event) => event.type === 'mcp.catalog');
  assert.equal(catalogs.length, 2);
  assert.equal(catalogs[0]?.summary.connecting, 1);
  assert.equal(catalogs[1]?.summary.connected, 1);
  assert.equal(catalogs[1]?.tools[0]?.name, 'echo');
});

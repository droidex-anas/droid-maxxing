import assert from 'node:assert/strict';
import test from 'node:test';

import { DroidMcpConfiguration } from './DroidMcpConfiguration.js';

test('Droid MCP configuration maps remote servers to the CLI contract', async () => {
  const calls: { args: string[]; cwd?: string }[] = [];
  const configuration = new DroidMcpConfiguration(async (args, cwd) => {
    calls.push({ args, ...(cwd ? { cwd } : {}) });
  });

  await configuration.add(
    {
      name: 'sentry',
      serverType: 'sse',
      url: 'https://mcp.example.test/events',
      headers: { Authorization: 'Bearer token' },
    },
    '/workspace',
  );

  assert.deepEqual(calls, [
    {
      args: [
        'mcp',
        'add',
        'sentry',
        'https://mcp.example.test/events',
        '--type',
        'sse',
        '--header',
        'Authorization: Bearer token',
      ],
      cwd: '/workspace',
    },
  ]);
});

test('Droid MCP configuration preserves local arguments and environment', async () => {
  const calls: string[][] = [];
  const configuration = new DroidMcpConfiguration(async (args) => {
    calls.push(args);
  });

  await configuration.add({
    name: 'database',
    serverType: 'stdio',
    command: 'npx',
    args: ['-y', '@example/database-mcp'],
    env: { DATABASE_URL: 'postgres://localhost/test' },
  });
  await configuration.remove('database');

  assert.deepEqual(calls, [
    [
      'mcp',
      'add',
      'database',
      'npx',
      '-y',
      '@example/database-mcp',
      '--type',
      'stdio',
      '--env',
      'DATABASE_URL=postgres://localhost/test',
    ],
    ['mcp', 'remove', 'database'],
  ]);
});

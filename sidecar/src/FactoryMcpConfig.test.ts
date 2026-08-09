import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadFactoryMcpServers } from './FactoryMcpConfig.js';

test('Factory MCP config layers user over project and omits disabled servers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'droidex-mcp-config-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  mkdirSync(path.join(home, '.factory'), { recursive: true });
  mkdirSync(path.join(project, '.factory'), { recursive: true });
  writeFileSync(
    path.join(project, '.factory', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        sentry: { type: 'http', url: 'https://project.example/mcp' },
        database: { command: 'db-mcp', args: ['--readonly'], env: { DATABASE_URL: 'secret' } },
        projectOnly: { type: 'sse', url: 'https://project.example/sse' },
      },
    }),
  );
  writeFileSync(
    path.join(home, '.factory', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          headers: { Authorization: 'Bearer token' },
        },
        projectOnly: { disabled: true },
        disabled: { type: 'stdio', command: 'disabled-mcp', args: [], disabled: true },
      },
    }),
  );

  try {
    assert.deepEqual(loadFactoryMcpServers(project, home), [
      {
        type: 'http',
        name: 'sentry',
        url: 'https://mcp.sentry.dev/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer token' }],
      },
      {
        name: 'database',
        command: 'db-mcp',
        args: ['--readonly'],
        env: { DATABASE_URL: 'secret' },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Factory MCP config fails with the exact invalid file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'droidex-mcp-config-invalid-'));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.factory'), { recursive: true });
  const configPath = path.join(home, '.factory', 'mcp.json');
  writeFileSync(configPath, '{bad json');

  try {
    assert.throws(() => loadFactoryMcpServers(root, home), new RegExp(configPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

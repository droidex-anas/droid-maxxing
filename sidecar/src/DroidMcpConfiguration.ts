import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { McpServerInput } from './protocol.js';
import { buildDroidInvocation } from './Environment.js';

const execFileAsync = promisify(execFile);

export interface McpConfiguration {
  add(server: McpServerInput, cwd?: string): Promise<void>;
  remove(serverName: string, cwd?: string): Promise<void>;
}

type RunMcpCommand = (args: string[], cwd?: string) => Promise<void>;

export class DroidMcpConfiguration implements McpConfiguration {
  constructor(private readonly run: RunMcpCommand = runMcpCommand) {}

  async add(server: McpServerInput, cwd?: string): Promise<void> {
    await this.run(addArguments(server), cwd);
  }

  async remove(serverName: string, cwd?: string): Promise<void> {
    await this.run(['mcp', 'remove', requireValue(serverName, 'Server name')], cwd);
  }
}

function addArguments(server: McpServerInput): string[] {
  const name = requireValue(server.name, 'Server name');
  if (server.serverType === 'stdio') {
    const args = [
      'mcp',
      'add',
      name,
      requireValue(server.command, 'Command'),
      ...(server.args ?? []),
      '--type',
      'stdio',
    ];
    for (const [key, value] of Object.entries(server.env ?? {}))
      args.push('--env', `${requireValue(key, 'Environment variable name')}=${value}`);
    return args;
  }

  const url = requireHttpUrl(server.url);
  const args = ['mcp', 'add', name, url, '--type', server.serverType];
  for (const [key, value] of Object.entries(server.headers ?? {}))
    args.push('--header', `${requireValue(key, 'Header name')}: ${value}`);
  return args;
}

async function runMcpCommand(args: string[], cwd?: string): Promise<void> {
  const invocation = buildDroidInvocation(args);
  await execFileAsync(invocation.execPath, invocation.execArgs, {
    ...(cwd ? { cwd } : {}),
    env: process.env,
    timeout: 30_000,
  });
}

function requireValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requireHttpUrl(value: string): string {
  const normalized = requireValue(value, 'Server URL');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Server URL must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Server URL must use HTTP or HTTPS.');
  return url.toString();
}

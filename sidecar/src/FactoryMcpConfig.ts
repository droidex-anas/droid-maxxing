import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '@factory/droid-sdk';
import { z } from 'zod';

const CommonConfigSchema = z.object({
  disabled: z.boolean().optional().default(false),
});

const FactoryServerConfigSchema = CommonConfigSchema.extend({
  type: z.enum(['http', 'sse', 'stdio']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
}).passthrough();

const FactoryConfigSchema = z
  .object({
    mcpServers: z.record(FactoryServerConfigSchema).default({}),
  })
  .passthrough();

type FactoryServerConfig = z.infer<typeof FactoryConfigSchema>['mcpServers'][string];

export function loadFactoryMcpServers(cwd: string, userHome = homedir()): McpServerConfig[] {
  const project = readConfig(path.join(cwd, '.factory', 'mcp.json'));
  const user = readConfig(path.join(userHome, '.factory', 'mcp.json'));
  const effective = new Map(Object.entries(project));
  for (const [name, config] of Object.entries(user)) {
    const inherited = effective.get(name);
    effective.set(name, inherited && !hasConnection(config) ? { ...inherited, ...config } : config);
  }

  const servers: McpServerConfig[] = [];
  for (const [name, config] of effective) {
    if (config.disabled) continue;
    servers.push(toRuntimeConfig(name, config));
  }
  return servers;
}

function readConfig(configPath: string): Record<string, FactoryServerConfig> {
  let contents: string;
  try {
    contents = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new Error(`Could not read Droid MCP config ${configPath}: ${errorMessage(error)}`);
  }

  try {
    return FactoryConfigSchema.parse(JSON.parse(contents)).mcpServers;
  } catch (error) {
    throw new Error(`Invalid Droid MCP config ${configPath}: ${errorMessage(error)}`);
  }
}

function toRuntimeConfig(name: string, config: FactoryServerConfig): McpServerConfig {
  if (config.command !== undefined) {
    return McpServerConfigSchema.parse({
      name,
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
    });
  }

  if (config.url !== undefined && (config.type === 'http' || config.type === 'sse')) {
    return McpServerConfigSchema.parse({
      name,
      type: config.type,
      url: config.url,
      headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
        name: headerName,
        value,
      })),
    });
  }

  throw new Error(`MCP server "${name}" must define a command or an HTTP/SSE URL.`);
}

function hasConnection(config: FactoryServerConfig): boolean {
  return config.command !== undefined || config.url !== undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Mirrored in src/types/mcp.ts — keep both files in sync.

export type McpServerType = 'http' | 'sse' | 'stdio';
export type McpServerStatus = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'disabled';
export type McpServerSource =
  | 'org'
  | 'runtime'
  | 'user'
  | 'project'
  | 'folder'
  | 'dynamic'
  | 'builtin';

export const MCP_SERVER_TYPES = [
  'http',
  'sse',
  'stdio',
] as const satisfies readonly McpServerType[];
export const MCP_HTTP_SERVER_TYPES = ['http', 'sse'] as const satisfies readonly Exclude<
  McpServerType,
  'stdio'
>[];
export const MCP_SERVER_STATUSES = [
  'connecting',
  'connected',
  'disconnected',
  'failed',
  'disabled',
] as const satisfies readonly McpServerStatus[];
export const MCP_SERVER_SOURCES = [
  'org',
  'runtime',
  'user',
  'project',
  'folder',
  'dynamic',
  'builtin',
] as const satisfies readonly McpServerSource[];

type AssertNoMissing<TUnion, TListed extends TUnion> =
  Exclude<TUnion, TListed> extends never
    ? true
    : ['missing enum members', Exclude<TUnion, TListed>];

const _mcpServerTypesComplete = true satisfies AssertNoMissing<
  McpServerType,
  (typeof MCP_SERVER_TYPES)[number]
>;
const _mcpHttpServerTypesComplete = true satisfies AssertNoMissing<
  Exclude<McpServerType, 'stdio'>,
  (typeof MCP_HTTP_SERVER_TYPES)[number]
>;
const _mcpServerStatusesComplete = true satisfies AssertNoMissing<
  McpServerStatus,
  (typeof MCP_SERVER_STATUSES)[number]
>;
const _mcpServerSourcesComplete = true satisfies AssertNoMissing<
  McpServerSource,
  (typeof MCP_SERVER_SOURCES)[number]
>;

export interface McpServerInfo {
  name: string;
  status: McpServerStatus;
  source: McpServerSource;
  isManaged: boolean;
  serverType?: McpServerType;
  error?: string;
  toolCount?: number;
  hasAuthTokens?: boolean;
  requiresAuth?: boolean;
}

export interface McpToolInfo {
  serverName: string;
  name: string;
  description?: string;
  isEnabled: boolean;
  isReadOnly?: boolean;
}

export interface McpStatusSummary {
  total: number;
  connected: number;
  connecting: number;
  failed: number;
  disabled?: number;
}

export type McpServerInput =
  | {
      name: string;
      serverType: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      name: string;
      serverType: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export type McpClientCommand =
  | { type: 'mcp.list'; requestId: string; cwd?: string }
  | { type: 'mcp.add'; requestId: string; cwd?: string; server: McpServerInput }
  | { type: 'mcp.remove'; requestId: string; cwd?: string; serverName: string }
  | { type: 'mcp.toggle'; requestId: string; cwd?: string; serverName: string; enabled: boolean }
  | { type: 'mcp.authenticate'; requestId: string; cwd?: string; serverName: string };

export type McpServerEvent =
  | {
      type: 'mcp.authRequested';
      requestId: string;
      providerSessionId?: string;
      serverName?: string;
      authUrl?: string;
      message?: string;
    }
  | {
      type: 'mcp.catalog';
      requestId: string;
      cwd?: string;
      servers: McpServerInfo[];
      tools: McpToolInfo[];
      summary: McpStatusSummary;
    }
  | { type: 'mcp.error'; requestId: string; message: string };

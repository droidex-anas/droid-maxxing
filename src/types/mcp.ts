// Mirrored in sidecar/src/mcpProtocol.ts — keep both files in sync.

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

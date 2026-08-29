import {
  McpAuthRequiredNotificationSchema,
  SettingsLevel,
  type McpServerStatusInfo,
  type McpStatusSummary as FactoryMcpStatusSummary,
  type McpToolInfo as FactoryMcpToolInfo,
} from '@factory/droid-sdk';

import type { McpConfiguration } from './DroidMcpConfiguration.js';
import type { FactorySession } from './providers/droid/DroidProviderSession.js';
import type {
  ClientCommand,
  McpServerInfo,
  McpStatusSummary,
  McpToolInfo,
  ServerEvent,
} from './protocol.js';
import { errMsg } from './sessionHelpers.js';

type McpCommand = Extract<ClientCommand, { type: `mcp.${string}` }>;
type Emit = (event: ServerEvent) => void;
const MCP_SETTLE_POLL_MS = 250;
const MCP_SETTLE_ATTEMPTS = 40;

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

export class McpSettings {
  constructor(
    private readonly createSession: (cwd?: string) => Promise<FactorySession>,
    private readonly configuration: McpConfiguration,
    private readonly emit: Emit,
    private readonly settleWait: (delayMs: number) => Promise<void> = wait,
  ) {}

  async handle(command: McpCommand): Promise<void> {
    let session: FactorySession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      if (command.type === 'mcp.add') await this.configuration.add(command.server, command.cwd);
      if (command.type === 'mcp.remove')
        await this.configuration.remove(command.serverName, command.cwd);

      session = await this.createSession(command.cwd);
      if (command.type === 'mcp.toggle') {
        await session.toggleMcpServer({
          serverName: requireName(command.serverName),
          enabled: command.enabled,
          settingsLevel: SettingsLevel.User,
        });
      }
      if (command.type === 'mcp.authenticate') {
        unsubscribe = session.onNotification((notification) => {
          const parsed = McpAuthRequiredNotificationSchema.safeParse(notification);
          if (!parsed.success) return;
          this.emit({
            type: 'mcp.authRequested',
            requestId: command.requestId,
            serverName: parsed.data.serverName,
            authUrl: parsed.data.authUrl,
            message: parsed.data.message,
          });
        });
        await session.authenticateMcpServer({ serverName: requireName(command.serverName) });
      }
      const needsSettlement = await this.emitCatalog(session, command.requestId, command.cwd);
      if (needsSettlement) await this.emitSettledCatalog(session, command.requestId, command.cwd);
    } catch (error) {
      this.emit({ type: 'mcp.error', requestId: command.requestId, message: errMsg(error) });
    } finally {
      unsubscribe?.();
      await session?.close().catch(() => undefined);
    }
  }

  private async emitCatalog(
    session: FactorySession,
    requestId: string,
    cwd?: string,
  ): Promise<boolean> {
    const [serverResult, toolResult] = await Promise.all([
      session.listMcpServers(),
      session.listMcpTools(),
    ]);
    this.emitCatalogResult(serverResult, toolResult, requestId, cwd);
    return (
      serverResult.summary.connecting > 0 ||
      (serverResult.summary.connected > 0 && toolResult.tools.length === 0)
    );
  }

  private async emitSettledCatalog(
    session: FactorySession,
    requestId: string,
    cwd?: string,
  ): Promise<void> {
    let connectedWithoutTools = 0;
    for (let attempt = 0; attempt < MCP_SETTLE_ATTEMPTS; attempt += 1) {
      await this.settleWait(MCP_SETTLE_POLL_MS);
      const serverResult = await session.listMcpServers();
      if (serverResult.summary.connecting > 0) continue;
      const toolResult = await session.listMcpTools();
      if (
        serverResult.summary.connected > 0 &&
        toolResult.tools.length === 0 &&
        connectedWithoutTools < 4
      ) {
        connectedWithoutTools += 1;
        continue;
      }
      this.emitCatalogResult(serverResult, toolResult, requestId, cwd);
      return;
    }
  }

  private emitCatalogResult(
    serverResult: Awaited<ReturnType<FactorySession['listMcpServers']>>,
    toolResult: Awaited<ReturnType<FactorySession['listMcpTools']>>,
    requestId: string,
    cwd?: string,
  ): void {
    this.emit({
      type: 'mcp.catalog',
      requestId,
      ...(cwd ? { cwd } : {}),
      servers: serverResult.servers.map(serverInfo),
      tools: toolResult.tools.map(toolInfo),
      summary: statusSummary(serverResult.summary),
    });
  }
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Server name is required.');
  return name;
}

function serverInfo(server: McpServerStatusInfo): McpServerInfo {
  return {
    name: server.name,
    status: server.status,
    source: server.source,
    isManaged: server.isManaged,
    ...(server.serverType === undefined ? {} : { serverType: server.serverType }),
    ...(server.error === undefined ? {} : { error: server.error }),
    ...(server.toolCount === undefined ? {} : { toolCount: server.toolCount }),
    ...(server.hasAuthTokens === undefined ? {} : { hasAuthTokens: server.hasAuthTokens }),
    ...('requiresAuth' in server && typeof server.requiresAuth === 'boolean'
      ? { requiresAuth: server.requiresAuth }
      : {}),
  };
}

function toolInfo(tool: FactoryMcpToolInfo): McpToolInfo {
  return {
    serverName: tool.serverName,
    name: tool.name,
    isEnabled: tool.isEnabled,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.isReadOnly === undefined ? {} : { isReadOnly: tool.isReadOnly }),
  };
}

function statusSummary(summary: FactoryMcpStatusSummary): McpStatusSummary {
  return {
    total: summary.total,
    connected: summary.connected,
    connecting: summary.connecting,
    failed: summary.failed,
    ...(summary.disabled === undefined ? {} : { disabled: summary.disabled }),
  };
}

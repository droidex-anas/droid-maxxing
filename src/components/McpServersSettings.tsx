import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { bridge } from '../lib/bridge';
import {
  addMcpServer,
  authenticateMcpServer,
  listMcpServers,
  removeMcpServer,
  toggleMcpServer,
} from '../lib/commands';
import type { McpServerInfo, McpServerInput, McpStatusSummary, McpToolInfo } from '../types/bridge';
import { AddMcpServerDialog } from './McpServerForm';
import { Switch } from './Switch';

let requestSequence = 0;
const nextRequestId = () => `mcp-${Date.now().toString(36)}-${String(++requestSequence)}`;

interface McpServersSectionProps {
  servers: McpServerInfo[];
  tools: McpToolInfo[];
  summary: McpStatusSummary;
  isLoading: boolean;
  isMutating: boolean;
  error?: string;
  onRefresh: () => void;
  onAdd: (server: McpServerInput) => void;
  onRemove: (serverName: string) => void;
  onToggle: (serverName: string, enabled: boolean) => void;
  onAuthenticate: (serverName: string) => void;
}

const EMPTY_SUMMARY: McpStatusSummary = {
  total: 0,
  connected: 0,
  connecting: 0,
  failed: 0,
  disabled: 0,
};

export function McpServersSettings({ cwd }: { cwd?: string }) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [summary, setSummary] = useState<McpStatusSummary>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequest = useRef<string | undefined>(undefined);

  const start = useCallback((mutation: boolean, send: (requestId: string) => void) => {
    const requestId = nextRequestId();
    activeRequest.current = requestId;
    setError(undefined);
    if (mutation) setIsMutating(true);
    else setIsLoading(true);
    send(requestId);
  }, []);

  const refresh = useCallback(() => {
    start(false, (requestId) => {
      listMcpServers(requestId, cwd);
    });
  }, [cwd, start]);

  useEffect(() => {
    const unsubscribe = bridge.subscribe((event) => {
      if (!('requestId' in event) || event.requestId !== activeRequest.current) return;
      if (event.type === 'mcp.authRequested' && event.authUrl) {
        void window.droidControl?.openExternal(event.authUrl);
        return;
      }
      if (event.type === 'mcp.error') {
        setError(event.message);
        setIsLoading(false);
        setIsMutating(false);
        return;
      }
      if (event.type !== 'mcp.catalog') return;
      setServers(event.servers);
      setTools(event.tools);
      setSummary(event.summary);
      setIsLoading(false);
      setIsMutating(false);
    });
    refresh();
    return unsubscribe;
  }, [refresh]);

  return (
    <McpServersSection
      servers={servers}
      tools={tools}
      summary={summary}
      isLoading={isLoading}
      isMutating={isMutating}
      error={error}
      onRefresh={refresh}
      onAdd={(server) => {
        start(true, (requestId) => {
          addMcpServer(requestId, server, cwd);
        });
      }}
      onRemove={(serverName) => {
        if (!window.confirm(`Remove the user MCP server “${serverName}”?`)) return;
        start(true, (requestId) => {
          removeMcpServer(requestId, serverName, cwd);
        });
      }}
      onToggle={(serverName, enabled) => {
        start(true, (requestId) => {
          toggleMcpServer(requestId, serverName, enabled, cwd);
        });
      }}
      onAuthenticate={(serverName) => {
        start(true, (requestId) => {
          authenticateMcpServer(requestId, serverName, cwd);
        });
      }}
    />
  );
}

export function McpServersSection(props: McpServersSectionProps) {
  const [isAdding, setIsAdding] = useState(false);
  const addStarted = useRef(false);
  const toolsByServer = useMemo(() => {
    const grouped = new Map<string, McpToolInfo[]>();
    for (const tool of props.tools) {
      const current = grouped.get(tool.serverName) ?? [];
      current.push(tool);
      grouped.set(tool.serverName, current);
    }
    return grouped;
  }, [props.tools]);

  useEffect(() => {
    if (!isAdding || !addStarted.current || props.isMutating) return;
    if (!props.error) setIsAdding(false);
    addStarted.current = false;
  }, [isAdding, props.error, props.isMutating]);

  let serverList: React.ReactNode;
  if (props.isLoading && props.servers.length === 0) {
    serverList = (
      <div className="flex items-center gap-2 rounded-xl border border-droid-border bg-droid-surface px-4 py-5 text-[12px] text-droid-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading MCP servers…
      </div>
    );
  } else if (props.servers.length === 0) {
    serverList = (
      <div className="rounded-xl border border-dashed border-droid-border px-5 py-8 text-center">
        <Server className="mx-auto mb-2 h-5 w-5 text-droid-text-muted" />
        <div className="text-[13px] font-medium text-droid-text">No MCP servers configured</div>
        <div className="mt-1 text-[11px] text-droid-text-muted">
          Add a user server here or define a project server in .factory/mcp.json.
        </div>
      </div>
    );
  } else {
    serverList = (
      <div className="divide-y divide-droid-border/80 overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
        {props.servers.map((server) => (
          <McpServerCard
            key={`${server.source}:${server.name}`}
            server={server}
            tools={toolsByServer.get(server.name) ?? []}
            disabled={props.isMutating}
            onRemove={props.onRemove}
            onToggle={props.onToggle}
            onAuthenticate={props.onAuthenticate}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-droid-text">MCP servers</h1>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-droid-text-muted">
            Shows Droid&apos;s effective server catalog and authentication state. User and project
            servers are merged with DROIDEX browser tools when sessions start.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={props.isLoading || props.isMutating}
          aria-label="Refresh MCP servers"
          className="rounded-lg border border-droid-border p-2 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${props.isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mb-5 flex items-center gap-2 text-[11px] text-droid-text-muted">
        <span>{props.summary.connected} connected</span>
        <span>·</span>
        <span>{props.summary.disabled ?? 0} disabled</span>
        {props.summary.failed > 0 && (
          <>
            <span>·</span>
            <span className="text-droid-orange">{props.summary.failed} failed</span>
          </>
        )}
      </div>

      {props.error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-droid-orange/30 bg-droid-orange/10 px-3 py-2.5 text-[12px] text-droid-text">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-droid-orange" />
          <span>{props.error}</span>
        </div>
      )}

      {serverList}

      <button
        type="button"
        onClick={() => {
          setIsAdding(true);
        }}
        className="mt-5 flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated px-3.5 py-2 text-[12px] font-medium text-droid-text transition-all duration-150 hover:border-droid-border-hover hover:bg-droid-active active:scale-[0.97]"
      >
        <Plus className="h-3.5 w-3.5" /> Add server
      </button>

      <AnimatePresence>
        {isAdding && (
          <AddMcpServerDialog
            disabled={props.isMutating}
            serverError={props.error}
            onCancel={() => {
              if (!props.isMutating) setIsAdding(false);
            }}
            onAdd={(server) => {
              addStarted.current = true;
              props.onAdd(server);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function McpServerCard({
  server,
  tools,
  disabled,
  onRemove,
  onToggle,
  onAuthenticate,
}: {
  server: McpServerInfo;
  tools: McpToolInfo[];
  disabled: boolean;
  onRemove: (serverName: string) => void;
  onToggle: (serverName: string, enabled: boolean) => void;
  onAuthenticate: (serverName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isEnabled = server.status !== 'disabled';
  const canRemove = server.source === 'user' && !server.isManaged;
  const shouldShowAuthenticate = canAuthenticate(server);

  return (
    <div className="group px-4 py-3.5 transition-colors hover:bg-droid-elevated/25">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => {
            setExpanded((value) => !value);
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left active:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent/35"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-100 ${expanded ? 'rotate-90' : ''}`}
          />
          <StatusIcon status={server.status} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-droid-text">
                {server.name}
              </span>
              <span className="rounded-full border border-droid-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-droid-text-muted">
                {sourceLabel(server.source)}
              </span>
              {server.serverType && (
                <span className="text-[9.5px] uppercase text-droid-text-muted">
                  {server.serverType}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[10.5px] capitalize text-droid-text-muted">
              {server.status}
              {server.toolCount !== undefined
                ? ` · ${String(server.toolCount)} ${server.toolCount === 1 ? 'tool' : 'tools'}`
                : ''}
            </span>
          </span>
        </button>
        {shouldShowAuthenticate && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onAuthenticate(server.name);
            }}
            className="rounded-lg border border-droid-border bg-droid-elevated px-2.5 py-1.5 text-[10.5px] font-medium text-droid-text transition-all duration-150 hover:border-droid-border-hover active:scale-[0.97] disabled:opacity-40"
          >
            Authenticate
          </button>
        )}
        <Switch
          checked={isEnabled}
          disabled={disabled}
          onChange={(enabled) => {
            onToggle(server.name, enabled);
          }}
          label={`${isEnabled ? 'Disable' : 'Enable'} ${server.name}`}
        />
        {canRemove && (
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${server.name}`}
            onClick={() => {
              onRemove(server.name);
            }}
            className="rounded-lg border border-transparent p-2 text-droid-text-secondary transition-all duration-150 hover:border-droid-orange/25 hover:bg-droid-orange/10 hover:text-droid-orange active:scale-[0.96] disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" /> <span className="sr-only">Remove</span>
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-6 mt-3 border-l border-droid-border/70 pl-4">
          {server.error && <div className="mb-3 text-[11px] text-droid-orange">{server.error}</div>}
          {tools.length === 0 ? (
            <div className="py-1 text-[11px] text-droid-text-muted">No tools reported.</div>
          ) : (
            <>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-droid-text-muted">
                Available tools
              </div>
              <div className="grid gap-x-6 gap-y-3 pb-1 sm:grid-cols-2">
                {tools.map((tool) => (
                  <div key={tool.name} className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11.5px] font-medium text-droid-text-secondary">
                        {tool.name}
                      </span>
                      {!tool.isEnabled && (
                        <span className="shrink-0 rounded-full bg-droid-elevated px-1.5 py-0.5 text-[9px] text-droid-text-muted">
                          Off
                        </span>
                      )}
                    </div>
                    {tool.description && (
                      <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-droid-text-muted">
                        {tool.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function canAuthenticate(server: McpServerInfo): boolean {
  if (server.serverType === 'stdio') return false;
  if (server.requiresAuth === true) return true;
  return (server.status === 'failed' || server.status === 'disconnected') && !server.hasAuthTokens;
}

function StatusIcon({ status }: { status: McpServerInfo['status'] }) {
  if (status === 'connected') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'connecting')
    return <Loader2 className="h-4 w-4 animate-spin text-droid-accent" />;
  if (status === 'failed') return <CircleAlert className="h-4 w-4 text-droid-orange" />;
  return <Server className="h-4 w-4 text-droid-text-muted" />;
}

function sourceLabel(source: McpServerInfo['source']): string {
  if (source === 'user') return 'User';
  if (source === 'project') return 'Project';
  if (source === 'folder') return 'Folder';
  if (source === 'org') return 'Organization';
  if (source === 'runtime') return 'DROIDEX';
  if (source === 'builtin') return 'Built in';
  return source;
}

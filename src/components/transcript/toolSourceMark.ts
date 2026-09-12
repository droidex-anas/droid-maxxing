import { useSyncExternalStore } from 'react';

import { bridge } from '../../lib/bridge';
import { listMcpServers } from '../../lib/commands';
import { describeLink, type LinkPresentation } from '../../lib/linkPresentation';
import type { McpServerInfo } from '../../types/bridge';

// The mark a tool row wears for the MCP server the tool came from.
//
// A server publishes no icon of its own: neither the Droid catalog the sidecar
// mirrors nor the SDK's server info carries one, and DROIDEX has no plugin
// registry to take one from. What a server does declare is where it lives, so
// an HTTP/SSE server is recognised by the favicon of its host, and everything
// else keeps the written-out source name the row already shows.
//
// Reading the catalog costs the sidecar a Droid session, so it is asked for
// once for the whole app and kept here. Resolving a source is then a map
// lookup, memoised per source string, so rendering a transcript never asks.

const hostsBySource = new Map<string, string>();
const marks = new Map<string, LinkPresentation | null>();
const listeners = new Set<() => void>();
let catalogRequested = false;

// Rows see the readable form of `mcp__<server>__<tool>` that `humanizeToolName`
// produces, so server names are matched in that form rather than raw.
// Services whose mark is known by name alone.
const KNOWN_HOSTS: readonly [name: string, host: string][] = [['github', 'github.com']];

function knownHost(key: string): string | undefined {
  return KNOWN_HOSTS.find(([name]) => key.includes(name))?.[1];
}

function sourceKey(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim().toLowerCase();
}

// The one way hosts get in here. Servers a catalog leaves out keep whatever it
// said about them last, so a project-scoped catalog never blanks a user one.
export function recordMcpCatalog(servers: readonly McpServerInfo[]): void {
  let changed = false;
  for (const server of servers) {
    const key = sourceKey(server.name);
    if (!server.host || hostsBySource.get(key) === server.host) continue;
    hostsBySource.set(key, server.host);
    changed = true;
  }
  if (!changed) return;
  marks.clear();
  for (const listener of listeners) listener();
}

function requestCatalog(): void {
  if (catalogRequested) return;
  catalogRequested = true;
  // Every catalog counts, including the ones the MCP settings screen asks for,
  // so a server added there earns its mark without a second round trip.
  bridge.subscribe((event) => {
    if (event.type === 'mcp.catalog') recordMcpCatalog(event.servers);
  });
  listMcpServers(`tool-marks-${Date.now().toString(36)}`);
}

export function toolSourceMark(source: string | undefined): LinkPresentation | null {
  if (!source) return null;
  const memoised = marks.get(source);
  if (memoised !== undefined) return memoised;
  const key = sourceKey(source);
  // Metadata first; a server without a configured host (a stdio install of a
  // well-known service) is still recognised by its name.
  const host = hostsBySource.get(key) ?? knownHost(key);
  // A host is shown the way a link to it would be, so a GitHub server wears the
  // bundled octocat and every other site wears its favicon.
  const mark = host ? describeLink(`https://${host}/`) : null;
  marks.set(source, mark);
  return mark;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A row with no MCP source has no mark to wait for, and must not make the app
// ask for a catalog it would never read.
function subscribeAndRequestCatalog(listener: () => void): () => void {
  requestCatalog();
  return subscribe(listener);
}

export function useToolSourceMark(source: string | undefined): LinkPresentation | null {
  const read = () => toolSourceMark(source);
  // The cache is a plain module value, so a transcript rendered to a string
  // reads exactly what a mounted one does.
  return useSyncExternalStore(source ? subscribeAndRequestCatalog : subscribe, read, read);
}

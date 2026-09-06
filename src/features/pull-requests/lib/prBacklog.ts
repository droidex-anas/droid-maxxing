import { comparablePath } from '../../../lib/pathComparison';

export const BACKLOG_LIMIT = 200;
export const BACKLOG_ID_MAX = 200;

export function prBacklogId(pr: { cwd: string; number: number; url?: string }): string {
  const fromUrl = githubPullRequestIdentity(pr.url);
  if (fromUrl) return fromUrl;
  return localPullRequestIdentity(pr.cwd, pr.number);
}

export function addPrBacklogId(ids: readonly string[], id: string): string[] | null {
  const next = id.trim();
  if (!next || next.length > BACKLOG_ID_MAX || ids.includes(next) || ids.length >= BACKLOG_LIMIT) {
    return null;
  }
  return [...ids, next];
}

export function removePrBacklogId(ids: readonly string[], id: string): string[] | null {
  if (!ids.includes(id)) return null;
  return ids.filter((item) => item !== id);
}

export function sanitizePersistedPrBacklog(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > BACKLOG_ID_MAX || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= BACKLOG_LIMIT) break;
  }
  return ids;
}

function githubPullRequestIdentity(url: string | undefined): string | null {
  if (!url) return null;
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url);
  if (!match) return null;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
}

function localPullRequestIdentity(cwd: string, number: number): string {
  const suffix = `#${number}`;
  const path = comparablePath(cwd);
  if (path.length + suffix.length <= BACKLOG_ID_MAX) return `${path}${suffix}`;
  return `p:${fnv1aHex(path)}${suffix}`;
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

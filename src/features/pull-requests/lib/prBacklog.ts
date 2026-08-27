import { comparablePath } from '../../../lib/pathComparison';

const BACKLOG_LIMIT = 200;
const BACKLOG_ID_MAX = 200;

export function prBacklogId(pr: { cwd: string; number: number; url?: string }): string {
  const fromUrl = githubPullRequestIdentity(pr.url);
  if (fromUrl) return fromUrl;
  return `${comparablePath(pr.cwd)}#${pr.number}`;
}

export function sanitizePersistedPrBacklog(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim().slice(0, BACKLOG_ID_MAX);
    if (!id || seen.has(id)) continue;
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

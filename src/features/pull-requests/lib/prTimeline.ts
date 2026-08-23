import type { PrComment, PrCommit, PullRequest } from '../../../types/vcs';

export type PrTone = 'neutral' | 'success' | 'danger' | 'accent';

export interface PrBadge {
  label: string;
  tone: PrTone;
}

// What the author did, phrased the way GitHub phrases it in the timeline.
export function commentActionLabel(comment: PrComment): string {
  const state = (comment.state ?? '').toLowerCase();
  if (state === 'approved') return 'approved these changes';
  if (state === 'changes_requested') return 'requested changes';
  if (state === 'dismissed') return 'dismissed a review';
  if (comment.kind === 'inline') return 'commented on a file';
  if (comment.kind === 'review') return 'reviewed';
  return 'commented';
}

export function reviewBadge(comment: PrComment): PrBadge | null {
  const state = (comment.state ?? '').toLowerCase();
  if (state === 'approved') return { label: 'Approved', tone: 'success' };
  if (state === 'changes_requested') return { label: 'Changes requested', tone: 'danger' };
  if (state === 'dismissed') return { label: 'Dismissed', tone: 'neutral' };
  return null;
}

export function inlineLocation(comment: PrComment): { label: string; title: string } | null {
  if (comment.kind !== 'inline' || !comment.path) return null;
  const name = comment.path.split('/').pop() ?? comment.path;
  const title = comment.line == null ? comment.path : `${comment.path}:${String(comment.line)}`;
  const label = comment.line == null ? name : `${name}:${String(comment.line)}`;
  return { label, title };
}

export type HunkLineTone = 'add' | 'del' | 'meta' | 'context';

export function hunkLineTone(line: string): HunkLineTone {
  if (line.startsWith('@@')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

// GitHub shows only the last few lines of a review hunk above the comment; the
// full hunk is available once expanded.
export function hunkLines(diffHunk: string, limit = 6): { lines: string[]; truncated: boolean } {
  const all = diffHunk.replace(/\n+$/, '').split('\n');
  if (all.length <= limit) return { lines: all, truncated: false };
  return { lines: all.slice(all.length - limit), truncated: true };
}

export interface PrOpenedEvent {
  author: string | null;
  createdAt: string | null;
  isDraft: boolean;
}

// The one timeline fact gh already gives us for free: who opened the PR, and
// when. Rendering it keeps the conversation from starting mid-air.
export function openedEvent(pr: PullRequest | null): PrOpenedEvent | null {
  if (!pr) return null;
  return { author: pr.author, createdAt: pr.createdAt, isDraft: pr.isDraft };
}

export function shortSha(oid: string): string {
  return oid.slice(0, 7);
}

export type PrTimelineItem =
  | { kind: 'comment'; id: string; comment: PrComment }
  | { kind: 'commits'; id: string; commits: PrCommit[] };

function timestamp(iso: string | null): number {
  const ms = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

// The timeline runs in commit/comment order, and a run of commits pushed
// between two comments reads as one "N commits" entry the way GitHub folds it.
export function buildPrTimeline(comments: PrComment[], commits: PrCommit[]): PrTimelineItem[] {
  const entries = [
    ...comments.map((comment) => ({
      at: timestamp(comment.createdAt),
      kind: 'comment' as const,
      comment,
    })),
    ...commits.map((commit) => ({
      at: timestamp(commit.committedDate),
      kind: 'commit' as const,
      commit,
    })),
  ].sort((a, b) => a.at - b.at);

  const items: PrTimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === 'comment') {
      items.push({ kind: 'comment', id: entry.comment.id, comment: entry.comment });
      continue;
    }
    const last = items.at(-1);
    if (last?.kind === 'commits') {
      last.commits.push(entry.commit);
      continue;
    }
    items.push({ kind: 'commits', id: `commits-${entry.commit.oid}`, commits: [entry.commit] });
  }
  return items;
}

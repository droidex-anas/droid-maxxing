import type { SessionSummary } from '../types/bridge';
import { chatDisplayTitle, isChatHidden, type ChatMetadataMap } from './chatMetadata';
import type { SessionAttentionKind } from './sessionAttention';
import { sessionIsLive } from './sessions';

export type SessionActivityStatus =
  | 'working'
  | 'approval'
  | 'input'
  | 'failed'
  | 'review'
  | 'ready'
  | 'settled';

export const ACTIVITY_LABELS: Record<SessionActivityStatus, string> = {
  working: 'Working',
  approval: 'Needs approval',
  input: 'Needs input',
  failed: 'Failed',
  review: 'Needs review',
  ready: 'Ready',
  settled: 'Settled',
};

export function sessionActivityStatus(
  session: SessionSummary,
  options: { attention: SessionAttentionKind | null; unread: boolean; settledAt?: number },
): SessionActivityStatus {
  if (options.attention === 'approval') return 'approval';
  if (options.attention === 'question') return 'input';
  if (sessionIsLive(session)) return 'working';
  if (options.settledAt !== undefined && session.updatedAt <= options.settledAt) return 'settled';
  if (session.phase === 'failed') return 'failed';
  return options.unread ? 'review' : 'ready';
}

export interface SidebarActivityPreferences {
  view: 'activity' | 'workspaces' | 'pull-requests';
  settled: Record<string, number>;
  order: 'recent' | 'oldest' | 'title';
  filter: 'all' | 'attention' | 'working' | 'ready' | 'settled';
  limit: number;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarActivityPreferences = {
  view: 'workspaces',
  settled: {},
  order: 'recent',
  filter: 'all',
  limit: 5,
};

const STORAGE_KEY = 'droid-sidebar-activity';

export function isSidebarOrder(value: unknown): value is SidebarActivityPreferences['order'] {
  return value === 'recent' || value === 'oldest' || value === 'title';
}

export function isSidebarFilter(value: unknown): value is SidebarActivityPreferences['filter'] {
  return (
    value === 'all' ||
    value === 'attention' ||
    value === 'working' ||
    value === 'ready' ||
    value === 'settled'
  );
}

export function loadSidebarActivity(storage: Pick<Storage, 'getItem'>): SidebarActivityPreferences {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULT_SIDEBAR_PREFERENCES, settled: {} };
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    !('view' in value) ||
    (value.view !== 'activity' && value.view !== 'workspaces' && value.view !== 'pull-requests') ||
    !('settled' in value) ||
    !value.settled ||
    typeof value.settled !== 'object' ||
    Array.isArray(value.settled)
  ) {
    throw new Error('Invalid sidebar activity preferences.');
  }
  if (
    !('order' in value) ||
    !isSidebarOrder(value.order) ||
    !('filter' in value) ||
    !isSidebarFilter(value.filter) ||
    !('limit' in value) ||
    typeof value.limit !== 'number' ||
    ![5, 10, 0].includes(value.limit)
  ) {
    throw new Error('Invalid sidebar display preferences.');
  }
  const settled: Record<string, number> = {};
  for (const [id, timestamp] of Object.entries(value.settled)) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      throw new Error('Invalid settled session timestamp.');
    }
    settled[id] = timestamp;
  }
  return {
    view: value.view,
    settled: pruneSettledSessions(settled, {}, {}),
    order: value.order,
    filter: value.filter,
    limit: value.limit,
  };
}

export function saveSidebarActivity(
  storage: Pick<Storage, 'setItem'>,
  value: SidebarActivityPreferences,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function compareSidebarSessions(
  a: SessionSummary,
  b: SessionSummary,
  order: SidebarActivityPreferences['order'],
  metadata?: ChatMetadataMap,
): number {
  if (order === 'title')
    return (
      chatDisplayTitle(a, metadata?.[a.appSessionId]).localeCompare(
        chatDisplayTitle(b, metadata?.[b.appSessionId]),
      ) || a.appSessionId.localeCompare(b.appSessionId)
    );
  return (
    (order === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt) ||
    a.appSessionId.localeCompare(b.appSessionId)
  );
}

export function matchesActivityFilter(
  status: SessionActivityStatus,
  filter: SidebarActivityPreferences['filter'],
): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return ['approval', 'input', 'failed', 'review'].includes(status);
  return status === filter;
}

export function canSettleSession(status: SessionActivityStatus): boolean {
  return status !== 'working' && status !== 'approval' && status !== 'input';
}

// Keep unloaded history markers, but discard known hidden or superseded entries.
// Retain the newest 1,000 markers so paging through history cannot grow storage forever.
export function pruneSettledSessions(
  settled: Record<string, number>,
  sessions: Partial<Record<string, SessionSummary>>,
  metadata: ChatMetadataMap,
): Record<string, number> {
  const entries = Object.entries(settled).filter(
    ([id, at]) => !isChatHidden(metadata[id]) && (sessions[id]?.updatedAt ?? at) <= at,
  );
  if (entries.length === Object.keys(settled).length && entries.length <= 1000) return settled;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 1000));
}

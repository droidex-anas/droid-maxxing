import { useReducer } from 'react';
import { SIDEBAR_VISIBLE_SESSION_LIMIT } from '../lib/workspaces';

interface PageAction {
  type: 'more' | 'less';
  group: string;
  limit: number;
}

export function sidebarPagination(
  counts: ReadonlyMap<string, number>,
  action: PageAction,
): ReadonlyMap<string, number> {
  if (action.limit === 0) return counts;
  const next = new Map(counts);
  if (action.type === 'less') next.delete(action.group);
  else
    next.set(
      action.group,
      (counts.get(action.group) ?? action.limit) + SIDEBAR_VISIBLE_SESSION_LIMIT,
    );
  return next;
}

// One pagination policy for workspace, Activity, and PR groups. Unlimited stays
// unlimited when the list loads earlier history through its Show more callback.
export function useSidebarPagination(limit: number) {
  const [counts, dispatch] = useReducer(sidebarPagination, new Map<string, number>());
  const defaultVisibleCount = limit === 0 ? Number.MAX_SAFE_INTEGER : limit;
  return {
    defaultVisibleCount,
    visibleCountFor: (group: string) => counts.get(group) ?? defaultVisibleCount,
    showMore: (group: string) => {
      dispatch({ type: 'more', group, limit });
    },
    showLess: (group: string) => {
      dispatch({ type: 'less', group, limit });
    },
  };
}

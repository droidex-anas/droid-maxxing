export const SIDEBAR_CONTENT_SEARCH_MIN_QUERY = 3;

export type SidebarSearchNoticeKind = 'unavailable' | 'indexing' | 'empty' | 'pending';

export function sidebarSearchNotice(input: {
  queryLength: number;
  pending: boolean;
  searchUnavailable: boolean;
  indexingIncomplete: boolean;
  entryCount: number;
}): { kind: SidebarSearchNoticeKind; layout: 'empty' | 'inline' } | null {
  if (input.searchUnavailable && input.queryLength >= SIDEBAR_CONTENT_SEARCH_MIN_QUERY) {
    return { kind: 'unavailable', layout: input.entryCount === 0 ? 'empty' : 'inline' };
  }
  if (input.pending && input.entryCount === 0) {
    return { kind: 'pending', layout: 'empty' };
  }
  if (input.indexingIncomplete && input.queryLength >= SIDEBAR_CONTENT_SEARCH_MIN_QUERY) {
    return { kind: 'indexing', layout: input.entryCount === 0 ? 'empty' : 'inline' };
  }
  if (input.entryCount === 0) {
    return { kind: 'empty', layout: 'empty' };
  }
  return null;
}

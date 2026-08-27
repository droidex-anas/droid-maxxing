import {
  HISTORY_INDEXING_INCOMPLETE_MESSAGE,
  HISTORY_SEARCH_UNAVAILABLE_MESSAGE,
} from '../lib/historyStatusCopy';
import type { SidebarSearchNoticeKind } from '../lib/sidebarSearchStatus';

export default function SidebarSearchNotice({
  kind,
  layout,
}: {
  kind: SidebarSearchNoticeKind;
  layout: 'empty' | 'inline';
}) {
  const message =
    kind === 'unavailable'
      ? HISTORY_SEARCH_UNAVAILABLE_MESSAGE
      : kind === 'indexing'
        ? HISTORY_INDEXING_INCOMPLETE_MESSAGE
        : kind === 'pending'
          ? 'Searching messages...'
          : 'No sessions found';
  const testId =
    kind === 'unavailable'
      ? 'sidebar-search-unavailable'
      : kind === 'indexing'
        ? 'sidebar-search-indexing'
        : undefined;

  if (layout === 'inline') {
    return (
      <div
        role="status"
        data-testid={testId}
        className="px-4 py-2 text-[12px] text-droid-text-muted"
      >
        {message}
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid={testId}
      className="px-4 py-8 text-center text-sm text-droid-text-muted"
    >
      {message}
    </div>
  );
}

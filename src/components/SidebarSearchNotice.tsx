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
  const message = noticeMessage(kind);
  const testId = noticeTestId(kind);

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

function noticeMessage(kind: SidebarSearchNoticeKind): string {
  switch (kind) {
    case 'unavailable':
      return HISTORY_SEARCH_UNAVAILABLE_MESSAGE;
    case 'indexing':
      return HISTORY_INDEXING_INCOMPLETE_MESSAGE;
    case 'pending':
      return 'Searching messages...';
    case 'empty':
      return 'No sessions found';
  }
}

function noticeTestId(kind: SidebarSearchNoticeKind): string | undefined {
  switch (kind) {
    case 'unavailable':
      return 'sidebar-search-unavailable';
    case 'indexing':
      return 'sidebar-search-indexing';
    case 'pending':
    case 'empty':
      return undefined;
  }
}

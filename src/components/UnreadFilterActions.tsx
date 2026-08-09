import { Bell } from 'lucide-react';

interface UnreadFilterActionsProps {
  unreadOnly: boolean;
  unreadCount: number;
  onToggleUnread: () => void;
  onMarkAllRead: () => void;
}

export function UnreadFilterActions({
  unreadOnly,
  unreadCount,
  onToggleUnread,
  onMarkAllRead,
}: UnreadFilterActionsProps) {
  return (
    <>
      {unreadOnly && unreadCount > 0 && (
        <button
          type="button"
          onClick={onMarkAllRead}
          className="rounded-md px-2 py-1.5 text-[10.5px] font-medium text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          Mark all as read
        </button>
      )}
      <button
        type="button"
        onClick={onToggleUnread}
        title={unreadOnly ? 'Show all sessions' : 'Show unread only'}
        aria-label={unreadOnly ? 'Show all sessions' : 'Show unread only'}
        aria-pressed={unreadOnly}
        className={`relative rounded-md p-1.5 transition-colors hover:bg-droid-elevated ${
          unreadOnly ? 'text-droid-accent' : 'text-droid-text-muted hover:text-droid-text'
        }`}
      >
        <Bell className="h-4 w-4" strokeWidth={1.75} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-droid-accent px-0.5 text-[8px] font-semibold tabular-nums text-droid-bg">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
    </>
  );
}

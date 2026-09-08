import { useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownAZ,
  Check,
  ChevronRight,
  CircleDashed,
  Clock,
  Folder,
  GitPullRequest,
  History,
  ListFilter,
  Loader,
  MessageCircleWarning,
} from 'lucide-react';
import { Popover } from './environment/Popover';
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  type SidebarActivityPreferences,
} from '../lib/sidebarActivity';

interface Props {
  preferences: SidebarActivityPreferences;
  unreadCount: number;
  onChange: (preferences: SidebarActivityPreferences) => void;
  onMarkAllRead: () => void;
}

interface Option<T> {
  value: T;
  label: string;
  icon?: ReactNode;
}

const ICON = 'h-4 w-4';
const VIEWS: Option<SidebarActivityPreferences['view']>[] = [
  { value: 'workspaces', label: 'Workspace', icon: <Folder className={ICON} strokeWidth={1.5} /> },
  { value: 'activity', label: 'Activity', icon: <Activity className={ICON} strokeWidth={1.5} /> },
  {
    value: 'pull-requests',
    label: 'Pull request',
    icon: <GitPullRequest className={ICON} strokeWidth={1.5} />,
  },
];
const ORDER: Option<SidebarActivityPreferences['order']>[] = [
  { value: 'recent', label: 'Last active', icon: <Clock className={ICON} strokeWidth={1.5} /> },
  { value: 'oldest', label: 'Oldest first', icon: <History className={ICON} strokeWidth={1.5} /> },
  { value: 'title', label: 'Name', icon: <ArrowDownAZ className={ICON} strokeWidth={1.5} /> },
];
const LIMIT: Option<SidebarActivityPreferences['limit']>[] = [
  { value: 5, label: '5 per group' },
  { value: 10, label: '10 per group' },
  { value: 0, label: 'Everything' },
];
const STATUS: Option<SidebarActivityPreferences['filter']>[] = [
  { value: 'all', label: 'Any status', icon: <CircleDashed className={ICON} strokeWidth={1.5} /> },
  {
    value: 'attention',
    label: 'Needs you',
    icon: <MessageCircleWarning className={ICON} strokeWidth={1.5} />,
  },
  { value: 'working', label: 'Working', icon: <Loader className={ICON} strokeWidth={1.5} /> },
  { value: 'ready', label: 'Recent', icon: <Clock className={ICON} strokeWidth={1.5} /> },
  { value: 'settled', label: 'Settled', icon: <Check className={ICON} strokeWidth={1.5} /> },
];

const ROW =
  'flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-droid-text transition-colors hover:bg-droid-elevated/70 focus-visible:bg-droid-elevated/70 focus-visible:outline-none';

type Submenu = 'view' | 'order' | 'limit' | 'filter';

// A menu row that flies its choices out to the right, macOS style. The row
// shows the current value; the flyout marks it with a check.
function FlyoutRow<T extends string | number>({
  id,
  label,
  value,
  options,
  open,
  onOpen,
  onChange,
  showValue = true,
  marked = false,
}: {
  id: Submenu;
  label: string;
  value: T;
  options: readonly Option<T>[];
  open: Submenu | null;
  onOpen: (id: Submenu) => void;
  onChange: (value: T) => void;
  showValue?: boolean;
  marked?: boolean;
}) {
  const current = options.find((option) => option.value === value);
  const isOpen = open === id;
  return (
    <div
      className="relative"
      onMouseEnter={() => {
        onOpen(id);
      }}
    >
      <button
        className={`${ROW} ${isOpen ? 'bg-droid-elevated/70' : ''}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => {
          onOpen(id);
        }}
      >
        <span className="flex-1">{label}</span>
        {showValue && <span className="text-droid-text-muted">{current?.label}</span>}
        {marked && <span className="h-1.5 w-1.5 rounded-full bg-droid-text-secondary" />}
        <ChevronRight className="h-4 w-4 text-droid-text-muted" strokeWidth={1.5} />
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label={label}
          className="absolute -top-1.5 left-full ml-1.5 w-[220px] rounded-xl border border-droid-border bg-droid-surface py-1.5 shadow-2xl shadow-black/50"
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                role="menuitemradio"
                aria-checked={selected}
                className={ROW}
                onClick={() => {
                  onChange(option.value);
                }}
              >
                <span className="flex w-4 shrink-0 justify-center text-droid-text-secondary">
                  {option.icon}
                </span>
                <span className="flex-1">{option.label}</span>
                {selected && <Check className="h-4 w-4" strokeWidth={2} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SidebarCustomize({ preferences, unreadCount, onChange, onMarkAllRead }: Props) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setSubmenu(null);
  };
  const filtered = preferences.filter !== DEFAULT_SIDEBAR_PREFERENCES.filter;
  const set = <K extends keyof SidebarActivityPreferences>(
    key: K,
    value: SidebarActivityPreferences[K],
  ) => {
    onChange({ ...preferences, [key]: value });
  };

  return (
    <div className="mx-3 mb-1 flex items-center justify-between">
      <span className="text-[11px] font-medium text-droid-text-muted">
        {VIEWS.find((view) => view.value === preferences.view)?.label}
      </span>
      <button
        ref={trigger}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        title="View options"
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded-md p-1.5 transition-colors hover:bg-droid-elevated focus-visible:bg-droid-elevated focus-visible:outline-none ${
          open || filtered ? 'text-droid-text' : 'text-droid-text-muted hover:text-droid-text'
        }`}
      >
        <ListFilter className="h-4 w-4" strokeWidth={1.5} />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={trigger}
        align="left"
        label="View options"
        width={256}
        className="overflow-visible"
      >
        <div
          className="py-1.5"
          onMouseLeave={() => {
            setSubmenu(null);
          }}
        >
          <FlyoutRow
            id="view"
            label="Grouping"
            value={preferences.view}
            options={VIEWS}
            open={submenu}
            onOpen={setSubmenu}
            onChange={(view) => {
              set('view', view);
            }}
          />
          <FlyoutRow
            id="order"
            label="Ordering"
            value={preferences.order}
            options={ORDER}
            open={submenu}
            onOpen={setSubmenu}
            onChange={(order) => {
              set('order', order);
            }}
          />
          <FlyoutRow
            id="limit"
            label="Show"
            value={preferences.limit}
            options={LIMIT}
            open={submenu}
            onOpen={setSubmenu}
            showValue={false}
            onChange={(limit) => {
              set('limit', limit);
            }}
          />
          <div className="mx-3.5 my-1.5 border-t border-droid-border" />
          <div className="flex items-center px-3.5 py-1.5 text-[13px] text-droid-text-muted">
            <span className="flex-1">Filters</span>
            {filtered && (
              <button
                className="transition-colors hover:text-droid-text"
                onClick={() => {
                  set('filter', DEFAULT_SIDEBAR_PREFERENCES.filter);
                }}
              >
                Reset
              </button>
            )}
          </div>
          <FlyoutRow
            id="filter"
            label="Status"
            value={preferences.filter}
            options={STATUS}
            open={submenu}
            onOpen={setSubmenu}
            showValue={false}
            marked={filtered}
            onChange={(filter) => {
              set('filter', filter);
            }}
          />
          <div className="mx-3.5 my-1.5 border-t border-droid-border" />
          <button
            className={`${ROW} disabled:text-droid-text-muted disabled:hover:bg-transparent`}
            disabled={unreadCount === 0}
            onMouseEnter={() => {
              setSubmenu(null);
            }}
            onClick={() => {
              onMarkAllRead();
              close();
            }}
          >
            Mark all as read
          </button>
        </div>
      </Popover>
    </div>
  );
}

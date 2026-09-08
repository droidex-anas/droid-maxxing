import { useRef, useState } from 'react';
import { ChevronDown, ListFilter } from 'lucide-react';
import { Popover } from './environment/Popover';
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  type SidebarActivityPreferences,
} from '../lib/sidebarActivity';

interface Props {
  preferences: SidebarActivityPreferences;
  onChange: (preferences: SidebarActivityPreferences) => void;
}

const VIEWS: { value: SidebarActivityPreferences['view']; label: string; hint: string }[] = [
  { value: 'workspaces', label: 'Workspaces', hint: 'Chats grouped by folder' },
  { value: 'activity', label: 'Activity', hint: 'What needs you, first' },
  { value: 'pull-requests', label: 'Pull requests', hint: 'Chats grouped by PR' },
];

const STATUS: { value: SidebarActivityPreferences['filter']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs you' },
  { value: 'working', label: 'Working' },
  { value: 'ready', label: 'Recent' },
  { value: 'settled', label: 'Settled' },
];

const ORDER: { value: SidebarActivityPreferences['order']; label: string }[] = [
  { value: 'recent', label: 'Last active' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Name' },
];

const LIMIT: { value: SidebarActivityPreferences['limit']; label: string }[] = [
  { value: 5, label: '5' },
  { value: 10, label: '10' },
  { value: 0, label: 'All' },
];

const ICON_BUTTON =
  'rounded-md p-1.5 transition-colors hover:bg-droid-elevated focus-visible:bg-droid-elevated focus-visible:outline-none';

// A row of pills for one preference; the whole row reads at a glance and one
// click changes it, unlike a nested dropdown.
function Pills<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="px-2.5 py-1.5">
      <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-droid-text-muted">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              aria-pressed={selected}
              onClick={() => {
                onChange(option.value);
              }}
              className={`rounded-full px-2.5 py-1 text-[12px] leading-none transition-colors ${
                selected
                  ? 'bg-droid-text text-droid-bg'
                  : 'bg-droid-elevated/70 text-droid-text-secondary hover:bg-droid-elevated hover:text-droid-text'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Sidebar header: the view name switches views; the funnel filters and sorts
// within the view. Both open flat, one-click popovers.
export function SidebarCustomize({ preferences, onChange }: Props) {
  const [open, setOpen] = useState<'view' | 'filter' | null>(null);
  const viewTrigger = useRef<HTMLButtonElement>(null);
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(null);
  };
  const filtered =
    preferences.filter !== DEFAULT_SIDEBAR_PREFERENCES.filter ||
    preferences.order !== DEFAULT_SIDEBAR_PREFERENCES.order ||
    preferences.limit !== DEFAULT_SIDEBAR_PREFERENCES.limit;

  return (
    <div className="mx-2 mb-1 flex items-center justify-between">
      <button
        ref={viewTrigger}
        onClick={() => {
          setOpen(open === 'view' ? null : 'view');
        }}
        aria-haspopup="menu"
        aria-expanded={open === 'view'}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
      >
        {VIEWS.find((view) => view.value === preferences.view)?.label}
        <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
      </button>
      <button
        ref={filterTrigger}
        onClick={() => {
          setOpen(open === 'filter' ? null : 'filter');
        }}
        title="Filter and sort"
        aria-label="Filter and sort"
        aria-haspopup="dialog"
        aria-expanded={open === 'filter'}
        className={`relative ${ICON_BUTTON} ${open === 'filter' || filtered ? 'text-droid-text' : 'text-droid-text-muted hover:text-droid-text'}`}
      >
        <ListFilter className="h-4 w-4" strokeWidth={1.5} />
        {filtered && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-droid-accent" />
        )}
      </button>

      <Popover
        open={open === 'view'}
        onClose={close}
        anchorRef={viewTrigger}
        align="left"
        label="Sidebar view"
        width={220}
      >
        <div role="menu" className="p-1">
          {VIEWS.map((view) => {
            const selected = view.value === preferences.view;
            return (
              <button
                key={view.value}
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange({ ...preferences, view: view.value });
                  close();
                }}
                className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60 ${
                  selected ? 'text-droid-text' : 'text-droid-text-secondary hover:text-droid-text'
                }`}
              >
                <span className="text-[12.5px] font-medium">{view.label}</span>
                <span className="text-[11px] text-droid-text-muted">{view.hint}</span>
              </button>
            );
          })}
        </div>
      </Popover>

      <Popover
        open={open === 'filter'}
        onClose={close}
        anchorRef={filterTrigger}
        label="Filter and sort"
        width={236}
      >
        <div className="py-1">
          <Pills
            label="Show"
            value={preferences.filter}
            options={STATUS}
            onChange={(filter) => {
              onChange({ ...preferences, filter });
            }}
          />
          <Pills
            label="Sort"
            value={preferences.order}
            options={ORDER}
            onChange={(order) => {
              onChange({ ...preferences, order });
            }}
          />
          <Pills
            label="Per group"
            value={preferences.limit}
            options={LIMIT}
            onChange={(limit) => {
              onChange({ ...preferences, limit });
            }}
          />
          {filtered && (
            <button
              onClick={() => {
                onChange({
                  ...DEFAULT_SIDEBAR_PREFERENCES,
                  view: preferences.view,
                  settled: preferences.settled,
                });
              }}
              className="mx-2.5 mb-1 mt-1 text-[11.5px] text-droid-text-muted transition-colors hover:text-droid-text"
            >
              Reset
            </button>
          )}
        </div>
      </Popover>
    </div>
  );
}

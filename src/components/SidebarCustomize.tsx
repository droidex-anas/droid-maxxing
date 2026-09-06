import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ListFilter } from 'lucide-react';
import { Popover } from './environment/Popover';
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  type SidebarActivityPreferences,
} from '../lib/sidebarActivity';

interface Props {
  preferences: SidebarActivityPreferences;
  onChange: (preferences: SidebarActivityPreferences) => void;
}

const rowClass =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:bg-droid-elevated/60 focus-visible:text-droid-text focus-visible:outline-none';

function ChoiceRow<T extends string | number>({
  label,
  value,
  options,
  open,
  onToggle,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  open: boolean;
  onToggle: () => void;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <button className={rowClass} aria-expanded={open} onClick={onToggle}>
        <span className="flex-1">{label}</span>
        <span className="text-droid-text-muted">
          {options.find((option) => option.value === value)?.label}
        </span>
        <ChevronDown
          className={`h-3 w-3 text-droid-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      </button>
      {open && (
        <div
          role="group"
          aria-label={label}
          className="mb-1 ml-2 border-l border-droid-border pl-1"
        >
          {options.map((option) => (
            <button
              key={option.value}
              aria-pressed={value === option.value}
              className={rowClass}
              onClick={() => {
                onChange(option.value);
              }}
            >
              <span className="flex-1">{option.label}</span>
              {value === option.value && (
                <Check className="h-3.5 w-3.5 text-droid-text" strokeWidth={1.5} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SidebarCustomize({ preferences, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<'view' | 'order' | 'limit' | 'filter' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setExpanded(null);
  }, []);
  const toggle = (section: NonNullable<typeof expanded>) => {
    setExpanded(expanded === section ? null : section);
  };
  const viewLabels = {
    activity: 'Activity',
    workspaces: 'Workspace view',
    'pull-requests': 'By pull request',
  };
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
    const current = buttons.findIndex((button) => button === document.activeElement);
    let next = current + (event.key === 'ArrowUp' ? -1 : 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div className="mx-3 mb-2 flex items-center justify-between">
      <span className="text-[11px] font-medium text-droid-text-muted">
        {viewLabels[preferences.view]}
      </span>
      <button
        ref={trigger}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        title="Customize sidebar"
        aria-label="Customize sidebar"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`rounded-md p-1.5 transition-colors hover:bg-droid-elevated focus-visible:bg-droid-elevated focus-visible:outline-none ${open ? 'bg-droid-elevated text-droid-text' : 'text-droid-text-muted hover:text-droid-text'}`}
      >
        <ListFilter className="h-4 w-4" strokeWidth={1.5} />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={trigger}
        label="Customize sidebar"
        width={264}
      >
        <div className="overflow-y-auto p-1 font-sans" onKeyDown={moveFocus}>
          <ChoiceRow
            label="Grouping"
            value={preferences.view}
            open={expanded === 'view'}
            onToggle={() => {
              toggle('view');
            }}
            options={[
              { value: 'workspaces', label: 'Workspace' },
              { value: 'activity', label: 'Activity' },
              { value: 'pull-requests', label: 'Pull request' },
            ]}
            onChange={(view) => {
              onChange({ ...preferences, view });
            }}
          />
          <ChoiceRow
            label="Ordering"
            value={preferences.order}
            open={expanded === 'order'}
            onToggle={() => {
              toggle('order');
            }}
            options={[
              { value: 'recent', label: 'Last active' },
              { value: 'oldest', label: 'Oldest activity' },
              { value: 'title', label: 'Name' },
            ]}
            onChange={(order) => {
              onChange({ ...preferences, order });
            }}
          />
          <ChoiceRow
            label="Show"
            value={preferences.limit}
            open={expanded === 'limit'}
            onToggle={() => {
              toggle('limit');
            }}
            options={[
              { value: 5, label: '5 per group' },
              { value: 10, label: '10 per group' },
              { value: 0, label: 'All tasks' },
            ]}
            onChange={(limit) => {
              onChange({ ...preferences, limit });
            }}
          />
          <div className="my-1 border-t border-droid-border" />
          <ChoiceRow
            label="Status"
            value={preferences.filter}
            open={expanded === 'filter'}
            onToggle={() => {
              toggle('filter');
            }}
            options={[
              { value: 'all', label: 'All tasks' },
              { value: 'attention', label: 'Needs attention' },
              { value: 'working', label: 'Working' },
              { value: 'settled', label: 'Settled' },
            ]}
            onChange={(filter) => {
              onChange({ ...preferences, filter });
            }}
          />
          <div className="my-1 border-t border-droid-border" />
          <button
            className={`${rowClass} text-droid-text-muted`}
            onClick={() => {
              onChange({ ...DEFAULT_SIDEBAR_PREFERENCES, settled: preferences.settled });
              setExpanded(null);
            }}
          >
            Reset view settings
          </button>
        </div>
      </Popover>
    </div>
  );
}

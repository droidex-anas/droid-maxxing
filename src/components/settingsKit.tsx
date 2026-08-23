// Shared layout primitives and controls for settings sections (SettingsPanel
// and the feature settings screens import these; keep them free of feature
// state).

import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from './environment/Popover';
import { focusDropdownOption, nextDropdownOptionIndex } from './settingsDropdown';

export function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold text-droid-text">{title}</h2>
      {sub && <p className="text-[12px] text-droid-text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

export function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium text-droid-text-muted uppercase tracking-wider mb-2 mt-1">
      {children}
    </div>
  );
}

/* ── generic in-app dropdown (replaces native <select>) ── */
export interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Select…',
  triggerIcon,
  width = 'w-44',
  align = 'right',
  disabled = false,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  /** Accessible name for the listbox popup (usually the field's label). */
  ariaLabel: string;
  placeholder?: string;
  triggerIcon?: React.ReactNode;
  width?: string;
  align?: 'left' | 'right';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const navigateOptions = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    let key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End':
        key = event.key;
        break;
      default:
        return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = nextDropdownOptionIndex({
      key,
      currentIndex: index,
      optionCount: items.length,
    });
    focusDropdownOption(items[nextIndex]);
  };

  const sel = options.find((o) => o.value === value);

  return (
    <div className={width === 'w-full' ? 'w-full' : 'shrink-0'}>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
        className={`${width} flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? 'border-droid-border-hover bg-droid-elevated text-droid-text'
            : 'border-droid-border bg-droid-bg/60 text-droid-text hover:border-droid-border-hover'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {triggerIcon ?? sel?.icon}
          <span className="truncate">{sel?.label ?? placeholder}</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-droid-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={triggerRef}
        id={listboxId}
        label={ariaLabel}
        align={align}
        width="anchor"
        role="listbox"
        initialFocusSelector={'[role="option"][aria-selected="true"]'}
        trapFocus={false}
        onKeyDown={navigateOptions}
        className="max-h-72 space-y-0.5 overflow-y-auto p-2"
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              role="option"
              aria-selected={active}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
              }`}
            >
              {o.icon}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
                {o.label}
              </span>
              {active && (
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--droid-accent)' }}
                  strokeWidth={3}
                />
              )}
            </button>
          );
        })}
      </Popover>
    </div>
  );
}

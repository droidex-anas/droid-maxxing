// Shared layout primitives and controls for settings sections (SettingsPanel
// and the feature settings screens import these; keep them free of feature
// state).

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

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
  placeholder = 'Select…',
  triggerIcon,
  width = 'w-44',
  align = 'right',
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  triggerIcon?: React.ReactNode;
  width?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Keyboard/screen-reader contract of a listbox popup: focus lands on the
    // selected option, arrows move between options, Escape returns focus to
    // the trigger.
    const menu = ref.current?.querySelector<HTMLElement>('[role="listbox"]');
    const selected =
      menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      menu?.querySelector<HTMLElement>('[role="option"]');
    selected?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'ArrowDown'
          ? items[(index + 1) % items.length]
          : items[(index - 1 + items.length) % items.length];
      next.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sel = options.find((o) => o.value === value);

  return (
    <div className={`relative ${width === 'w-full' ? 'w-full' : 'shrink-0'}`} ref={ref}>
      <button
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className={`${width} flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
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

      {open && (
        <div
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-50 mt-1.5 min-w-full rounded-xl border border-droid-border bg-droid-surface p-2 shadow-2xl shadow-black/50`}
        >
          <div className="max-h-72 overflow-y-auto space-y-0.5" role="listbox">
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
                    triggerRef.current?.focus();
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
                      className="w-3.5 h-3.5 shrink-0"
                      style={{ color: 'var(--droid-accent)' }}
                      strokeWidth={3}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

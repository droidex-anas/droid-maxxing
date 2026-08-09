// Modal editor for custom theme presets. Edits apply to the whole window live
// (WYSIWYG) and are rolled back on cancel; saving hands the draft to the
// parent, which persists the preset and selects it.

import { useEffect, useRef, useState } from 'react';
import { Moon, Sun, X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { applyTheme, type ThemeColors } from '../lib/theme';
import { ColorField } from './ColorPicker';
import { pushEscapeLayer } from './environment/usePopover';
import { MiniAppFrame, ThemeSwatches } from './ThemePreview';

export interface ThemeDraft {
  name: string;
  light: ThemeColors;
  dark: ThemeColors;
}

const COLOR_FIELDS: { key: keyof ThemeColors; label: string; description: string }[] = [
  { key: 'accent', label: 'Accent', description: 'Highlights, active states, send button' },
  { key: 'bg', label: 'App background', description: 'The main window behind everything' },
  { key: 'fg', label: 'Text color', description: 'Default color for all text' },
  { key: 'surface', label: 'Panel background', description: 'Sidebar, cards and raised surfaces' },
  { key: 'border', label: 'Borders', description: 'Dividers and outlines between sections' },
];

export function ThemeEditor({
  title,
  initial,
  error,
  onSave,
  onCancel,
}: {
  title: string;
  initial: ThemeDraft;
  /** Save/persistence failure from the parent; the dialog stays open so the
   * user can retry. */
  error?: string | null;
  onSave: (draft: ThemeDraft) => void;
  onCancel: () => void;
}) {
  const { state } = useStore();
  // The store theme is never dispatched while the editor is open, but an
  // external update (e.g. an OS scheme change) can still land, so track the
  // latest store theme: cancel restores it instead of a stale open-time
  // snapshot.
  const latestTheme = useRef(state.theme);
  latestTheme.current = state.theme;
  const savedRef = useRef(false);
  const [draft, setDraft] = useState<ThemeDraft>(initial);
  // Resolve System mode with the same media query the appearance section uses,
  // so the editor opens on the variant actually on screen.
  const [editing, setEditing] = useState<'light' | 'dark'>(() =>
    state.theme.mode === 'light' ||
    (state.theme.mode === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light'
      : 'dark',
  );

  // Live-preview the variant being edited across the whole app.
  useEffect(() => {
    applyTheme({ ...state.theme, ...draft[editing] });
  }, [state.theme, draft, editing]);

  useEffect(() => {
    return () => {
      if (!savedRef.current) applyTheme(latestTheme.current);
    };
  }, []);

  // Cancel is an Escape layer (shared LIFO stack, see usePopover.ts): color
  // popovers opened from this dialog push above it, so Escape always closes
  // only the innermost layer instead of discarding every edit at once.
  useEffect(() => pushEscapeLayer(onCancel), [onCancel]);

  // While the app is in System mode, keep the edited variant on the one the OS
  // actually shows; otherwise a scheme flip mid-edit leaves the preview on
  // stale colors (App dispatches the new variant, but draft[editing] would
  // keep overriding it with the variant selected at open time).
  useEffect(() => {
    if (state.theme.mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      setEditing(mq.matches ? 'light' : 'dark');
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, [state.theme.mode]);

  // aria-modal contract: Tab must cycle inside the dialog and focus returns
  // to the element that opened it. Same focusable-element query and wrap
  // logic the environment Popover uses for its Tab trap; the color popover
  // portals to <body>, so it counts as inside via its data attribute.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const containsFocus = (node: HTMLElement | null) => {
      if (!node) return false;
      if (dialogRef.current?.contains(node)) return true;
      return document.querySelector('[data-color-popover]')?.contains(node) ?? false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !containsFocus(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !containsFocus(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, []);

  const setColor = (key: keyof ThemeColors, value: string) => {
    setDraft((d) => ({ ...d, [editing]: { ...d[editing], [key]: value } }));
  };

  const name = draft.name.trim();
  const save = () => {
    if (!name) return;
    savedRef.current = true;
    onSave({ ...draft, name });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-editor-title"
        className="w-[560px] max-w-full rounded-2xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h3 id="theme-editor-title" className="text-[14px] font-semibold text-droid-text">
            {title}
          </h3>
          <button
            onClick={onCancel}
            aria-label="Close theme editor"
            className="rounded-md p-1 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-4">
          {/* Live preview: wireframe plus the theme's icon glyph */}
          <div className="relative h-44 overflow-hidden rounded-xl border border-droid-border">
            <MiniAppFrame colors={draft[editing]} />
            <div className="pointer-events-none absolute bottom-3 right-3 rounded-xl border border-droid-border bg-droid-bg/70 p-3 backdrop-blur-sm">
              <ThemeSwatches
                preset={{
                  id: 'draft',
                  name: draft.name || 'Draft',
                  light: draft.light,
                  dark: draft.dark,
                }}
                scheme={editing}
                size={36}
              />
            </div>
            <div className="absolute right-2 top-2 flex gap-1 rounded-lg border border-droid-border bg-droid-bg/80 p-0.5 backdrop-blur-sm">
              <button
                type="button"
                title="Edit light variant"
                aria-pressed={editing === 'light'}
                onClick={() => {
                  setEditing('light');
                }}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                  editing === 'light'
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:text-droid-text'
                }`}
              >
                <Sun className="h-3 w-3" />
                Light
              </button>
              <button
                type="button"
                title="Edit dark variant"
                aria-pressed={editing === 'dark'}
                onClick={() => {
                  setEditing('dark');
                }}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                  editing === 'dark'
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:text-droid-text'
                }`}
              >
                <Moon className="h-3 w-3" />
                Dark
              </button>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1.5 block text-[11px] text-droid-text-muted" htmlFor="theme-name">
              Theme name
            </label>
            <input
              id="theme-name"
              autoFocus
              value={draft.name}
              onChange={(e) => {
                setDraft((d) => ({ ...d, name: e.target.value }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              placeholder="My theme"
              spellCheck={false}
              className="h-8 w-full rounded-lg border border-droid-border bg-droid-bg/60 px-2.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted focus:border-droid-border-hover focus:outline-none"
            />
          </div>

          <div className="mt-3 space-y-3">
            {COLOR_FIELDS.map(({ key, label, description }) => (
              <ColorField
                key={`${editing}-${key}`}
                label={`${label} · ${editing}`}
                description={description}
                value={draft[editing][key]}
                onChange={(v) => {
                  setColor(key, v);
                }}
              />
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="px-5 pb-2 text-[11.5px] text-droid-red">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-droid-border px-5 py-3">
          <button
            onClick={onCancel}
            className="h-8 rounded-lg border border-droid-border px-3 text-[12px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!name}
            className="h-8 rounded-lg bg-droid-accent px-3 text-[12px] text-droid-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Save theme
          </button>
        </div>
      </div>
    </div>
  );
}

// Modal editor for custom theme presets. Edits apply to the whole window live
// (WYSIWYG) and are rolled back on cancel; saving hands the draft to the
// parent, which persists the preset and selects it.

import { useEffect, useRef, useState } from 'react';
import { Moon, Sun, X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { applyTheme, type ThemeColors } from '../lib/theme';
import { ColorField } from './ColorPicker';
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
  onSave,
  onCancel,
}: {
  title: string;
  initial: ThemeDraft;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

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

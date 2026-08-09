// The theme preset card: header with the preset dropdown and Import, one row
// per palette color (solid pill swatch + hex that opens the picker popover),
// quick accents, and a footer with the preset actions (new, duplicate, and —
// for custom themes — edit, export, delete). Manual color edits detach from
// the active preset into an unsaved custom look until saved as a theme.

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { persistCustomThemes, useStore, type ThemeConfig } from '../hooks/useStore';
import {
  applyTheme,
  BUILT_IN_THEMES,
  contrastRatio,
  CUSTOM_THEME_ID,
  DEFAULT_THEME,
  findPreset,
  newCustomThemeId,
  parseThemePresetImport,
  removeCustomTheme,
  resolveVariant,
  upsertCustomTheme,
  type ThemeColors,
  type ThemePreset,
} from '../lib/theme';
import { ColorPicker, ColorPopover } from './ColorPicker';
import { Dropdown } from './settingsKit';
import { ThemeEditor, type ThemeDraft } from './ThemeEditor';
import { ThemeSwatches } from './ThemePreview';

const QUICK_ACCENTS = [
  '#ee6018',
  '#ef6f2e',
  '#d15010',
  '#e8a838',
  '#4a9e7a',
  '#4ecdc4',
  '#7a8aaa',
  '#a78bfa',
  '#f87171',
  '#fcfcfc',
];

const COLOR_ROWS: { key: keyof ThemeColors; label: string; description: string }[] = [
  {
    key: 'accent',
    label: 'Accent',
    description: 'Highlights, active states, send button & design-mode controls',
  },
  { key: 'bg', label: 'App background', description: 'The main window behind everything' },
  { key: 'fg', label: 'Text color', description: 'Default color for all text' },
  { key: 'surface', label: 'Panel background', description: 'Sidebar, cards and raised surfaces' },
  { key: 'border', label: 'Borders', description: 'Dividers and outlines between sections' },
];

type EditorState =
  | { kind: 'create'; draft: ThemeDraft }
  | { kind: 'edit'; id: string; draft: ThemeDraft };

// Ink (near-black or near-white) with the better contrast against a filled
// pill/swatch — shared by the color rows and the quick-accent checks so the
// rule stays in one place.
const contrastInk = (value: string): string =>
  contrastRatio(value, '#101010') >= contrastRatio(value, '#f7f7f7') ? '#101010' : '#f7f7f7';

function CardButton({
  icon: Icon,
  label,
  danger = false,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition-colors ${
        danger
          ? 'text-droid-red hover:bg-droid-red/10'
          : 'text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** One color row: label on the left, solid pill (ring dot + hex) on the right. */
function ThemeColorRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  // The pill is filled with the color itself; the hex picks whichever ink
  // (near-black or near-white) has better contrast against it.
  const ink = contrastInk(value);
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-droid-border">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        <div className="text-[11px] text-droid-text-muted">{description}</div>
      </div>
      <button
        ref={pillRef}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
        }}
        title={`Pick ${label.toLowerCase()}`}
        className="flex h-8 min-w-[124px] shrink-0 items-center gap-2 rounded-lg px-2.5 font-mono text-[11px] uppercase transition-transform hover:scale-[1.02]"
        style={{
          backgroundColor: value,
          color: ink,
          boxShadow: 'inset 0 0 0 1px rgba(128, 128, 128, 0.3)',
        }}
      >
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          style={{ boxShadow: `inset 0 0 0 1.5px ${ink}` }}
        />
        {value}
      </button>
      {open && (
        <ColorPopover
          anchor={pillRef.current}
          onClose={() => {
            setOpen(false);
          }}
        >
          <ColorPicker value={value} onChange={onChange} />
        </ColorPopover>
      )}
    </div>
  );
}

export function ThemePresetCard({ resolvedScheme }: { resolvedScheme: 'light' | 'dark' }) {
  const { state, dispatch } = useStore();
  const theme = state.theme;
  const customThemes = state.customThemes;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const activePreset = findPreset(theme.presetId, customThemes);
  const activeIsCustom = activePreset ? customThemes.some((p) => p.id === activePreset.id) : false;
  // Palette behind previews: the active preset, or the default when the
  // current colors are hand-edited and match no preset.
  const previewPreset = activePreset ?? DEFAULT_THEME;

  const updateTheme = (patch: Partial<ThemeConfig>) => {
    dispatch({ type: 'SET_THEME', theme: patch });
    applyTheme({ ...theme, ...patch });
  };

  const selectTheme = (preset: ThemePreset) => {
    setDeleteArmed(false);
    updateTheme({ presetId: preset.id, ...resolveVariant(preset, theme.mode) });
  };

  // Manual color edits detach from the preset: the look becomes unsaved custom
  // colors until the user saves them as a theme.
  const updateColors = (patch: Partial<ThemeColors>) => {
    updateTheme({ ...patch, presetId: CUSTOM_THEME_ID });
  };

  const currentColors = (): ThemeColors => ({
    bg: theme.bg,
    fg: theme.fg,
    surface: theme.surface,
    border: theme.border,
    accent: theme.accent,
  });

  /* ── editor flows ── */
  const openNewTheme = () => {
    setEditor({
      kind: 'create',
      draft: { name: '', light: { ...previewPreset.light }, dark: { ...previewPreset.dark } },
    });
  };
  const openSaveCurrentAs = () => {
    const draft: ThemeDraft = {
      name: '',
      light: { ...previewPreset.light },
      dark: { ...previewPreset.dark },
    };
    draft[resolvedScheme] = currentColors();
    setEditor({ kind: 'create', draft });
  };
  const openDuplicate = (p: ThemePreset) => {
    setEditor({
      kind: 'create',
      draft: { name: `${p.name} copy`, light: { ...p.light }, dark: { ...p.dark } },
    });
  };
  const openEdit = (p: ThemePreset) => {
    setEditor({
      kind: 'edit',
      id: p.id,
      draft: { name: p.name, light: { ...p.light }, dark: { ...p.dark } },
    });
  };

  // Persist BEFORE dispatching (the reducer is pure; a throw there would
  // surface during render and unmount the app). On a storage failure we keep
  // state untouched and show a retryable error — the editor stays open.
  const persistThemes = (next: ThemePreset[], failure: string): boolean => {
    try {
      persistCustomThemes(next);
      setThemeError(null);
      return true;
    } catch {
      setThemeError(failure);
      return false;
    }
  };

  const handleSave = (draft: ThemeDraft) => {
    const id = editor?.kind === 'edit' ? editor.id : newCustomThemeId();
    const preset: ThemePreset = { id, name: draft.name, light: draft.light, dark: draft.dark };
    if (
      !persistThemes(
        upsertCustomTheme(customThemes, preset),
        'Could not save the theme — browser storage is unavailable. Fix that and try again.',
      )
    )
      return;
    dispatch({ type: 'SAVE_CUSTOM_THEME', preset });
    updateTheme({ presetId: id, ...resolveVariant(preset, theme.mode) });
    setEditor(null);
  };

  const handleDelete = (p: ThemePreset) => {
    if (
      !persistThemes(
        removeCustomTheme(customThemes, p.id),
        'Could not delete the theme — browser storage is unavailable. Fix that and try again.',
      )
    )
      return;
    dispatch({ type: 'DELETE_CUSTOM_THEME', id: p.id });
    // Deleting the active theme falls back to the default so presetId never
    // dangles.
    if (theme.presetId === p.id) {
      updateTheme({ presetId: DEFAULT_THEME.id, ...resolveVariant(DEFAULT_THEME, theme.mode) });
    }
  };

  // Delete is a two-click confirm: the first click arms the button for a few
  // seconds, the second actually deletes.
  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => {
      setDeleteArmed(false);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [deleteArmed]);

  /* ── export / import ── */
  const exportTheme = (p: ThemePreset) => {
    const payload = { name: p.name, light: p.light, dark: p.dark };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'theme'}.theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseThemePresetImport(JSON.parse(await file.text()));
      if (!parsed) {
        setThemeError('That file is not a valid theme export.');
        return;
      }
      setThemeError(null);
      // Open the editor so the import is previewed and named before saving.
      setEditor({ kind: 'create', draft: parsed });
    } catch {
      setThemeError('Could not read that file — expected a JSON theme export.');
    }
  };

  const allPresets = [...BUILT_IN_THEMES, ...customThemes];
  const unsavedColors = activePreset ? null : currentColors();
  const themeOptions = [
    // Hand-tuned colors that match no preset show up as an unsaved custom
    // entry so the dropdown always reflects what is on screen.
    ...(unsavedColors
      ? [
          {
            value: CUSTOM_THEME_ID,
            label: 'Custom (unsaved)',
            icon: (
              <ThemeSwatches
                preset={{
                  id: CUSTOM_THEME_ID,
                  name: 'Custom',
                  light: unsavedColors,
                  dark: unsavedColors,
                }}
                scheme={resolvedScheme}
                size={20}
              />
            ),
          },
        ]
      : []),
    ...allPresets.map((p) => ({
      value: p.id,
      label: p.name,
      icon: <ThemeSwatches preset={p} scheme={resolvedScheme} size={20} />,
    })),
  ];

  return (
    <div className="rounded-xl border border-droid-border bg-droid-surface mb-8">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-droid-border">
        <div className="text-[13px] font-medium text-droid-text">
          {resolvedScheme === 'dark' ? 'Dark' : 'Light'} theme
        </div>
        <div className="flex items-center gap-1">
          <CardButton
            icon={Upload}
            label="Import"
            onClick={() => {
              importInputRef.current?.click();
            }}
          />
          <Dropdown
            value={theme.presetId}
            width="w-48"
            options={themeOptions}
            onChange={(id) => {
              if (id === CUSTOM_THEME_ID) return;
              const preset = findPreset(id, customThemes);
              if (preset) selectTheme(preset);
            }}
          />
        </div>
      </div>
      {themeError && <p className="px-4 pt-2.5 text-[11px] text-droid-red">{themeError}</p>}

      <div className="px-4 [&>*:last-child]:border-b-0">
        {COLOR_ROWS.map(({ key, label, description }) => (
          <ThemeColorRow
            key={key}
            label={label}
            description={description}
            value={theme[key]}
            onChange={(v) => {
              updateColors({ [key]: v });
            }}
          />
        ))}
        <div className="flex items-center justify-between gap-3 py-2.5 border-b border-droid-border">
          <div>
            <div className="text-[13px] text-droid-text">Quick accents</div>
            <div className="text-[11px] text-droid-text-muted">One-tap accent colors</div>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {QUICK_ACCENTS.map((c) => {
              const selected = theme.accent.toLowerCase() === c.toLowerCase();
              // The check sits on the swatch itself (a white check vanishes on
              // the near-white accent).
              const ink = contrastInk(c);
              return (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => {
                    updateColors({ accent: c });
                  }}
                  className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                    selected ? 'border-droid-text' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                >
                  {selected && (
                    <Check className="w-3 h-3 mx-auto" style={{ color: ink }} strokeWidth={3} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-droid-border px-2.5 py-2">
        <div className="flex items-center">
          <CardButton icon={Plus} label="New theme" onClick={openNewTheme} />
          {activePreset && (
            <CardButton
              icon={Copy}
              label="Duplicate"
              onClick={() => {
                openDuplicate(activePreset);
              }}
            />
          )}
          {activeIsCustom && activePreset && (
            <>
              <CardButton
                icon={Pencil}
                label="Edit"
                onClick={() => {
                  openEdit(activePreset);
                }}
              />
              <CardButton
                icon={Download}
                label="Export"
                onClick={() => {
                  exportTheme(activePreset);
                }}
              />
              <CardButton
                icon={Trash2}
                label={deleteArmed ? 'Click again to delete' : 'Delete'}
                danger={deleteArmed}
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true);
                    return;
                  }
                  setDeleteArmed(false);
                  handleDelete(activePreset);
                }}
              />
            </>
          )}
        </div>
        {!activePreset && (
          <CardButton icon={Plus} label="Save as theme…" onClick={openSaveCurrentAs} />
        )}
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          void handleImportFile(e);
        }}
      />
      {editor && (
        <ThemeEditor
          title={editor.kind === 'edit' ? 'Edit theme' : 'New theme'}
          initial={editor.draft}
          error={themeError}
          onSave={handleSave}
          onCancel={() => {
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}

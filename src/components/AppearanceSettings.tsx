// Appearance settings: color-scheme cards with live wireframe previews, a grid
// of built-in + custom theme presets, and a custom-theme editor. Manual color
// edits still work directly; they become an unsaved "custom" look until saved
// as a theme.

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { useStore, type ThemeConfig } from '../hooks/useStore';
import {
  applyTheme,
  BUILT_IN_THEMES,
  CUSTOM_THEME_ID,
  DEFAULT_THEME,
  findPreset,
  newCustomThemeId,
  parseThemePresetImport,
  resolveVariant,
  UI_FONTS,
  type ThemeColors,
  type ThemeMode,
  type ThemePreset,
} from '../lib/theme';
import { ColorField } from './ColorPicker';
import { Dropdown, GroupLabel, SectionTitle } from './settingsKit';
import { ThemeEditor, type ThemeDraft } from './ThemeEditor';
import { SchemePreview, ThemeSwatches } from './ThemePreview';

const PRESET_ACCENTS = [
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

/* ── shared controls ── */
function ColorSwatch({
  color,
  active,
  onClick,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
        active ? 'border-droid-text' : 'border-transparent'
      }`}
      style={{ backgroundColor: color }}
    >
      {active && <Check className="w-3 h-3 text-white mx-auto" strokeWidth={3} />}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] transition-colors ${
        active
          ? 'bg-droid-elevated text-droid-text border border-droid-border'
          : 'text-droid-text-muted hover:text-droid-text'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function Slider({
  label,
  sub,
  value,
  min,
  max,
  onChange,
  suffix = '',
}: {
  label: string;
  sub?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-droid-border">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            onChange(Number(e.target.value));
          }}
          className="w-32 h-1 rounded-full cursor-pointer"
          style={{ accentColor: 'var(--droid-accent)' }}
        />
        <span className="font-mono text-[11px] text-droid-text-muted w-8 text-right">
          {value}
          {suffix}
        </span>
      </div>
    </div>
  );
}

function Toggle({
  label,
  sub,
  checked,
  onChange,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-droid-border">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <button
        onClick={() => {
          onChange(!checked);
        }}
        className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
      >
        <span
          className={`w-5 h-5 rounded-full shadow-sm transition-transform ${checked ? 'bg-droid-bg translate-x-4' : 'bg-droid-text-secondary translate-x-0'}`}
        />
      </button>
    </div>
  );
}

/* ── color scheme card (System / Light / Dark) ── */
function SchemeCard({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-xl border p-2 text-left transition-colors ${
        active ? 'border-droid-accent' : 'border-droid-border hover:border-droid-border-hover'
      }`}
      style={active ? { boxShadow: '0 0 0 1px var(--droid-accent)' } : undefined}
    >
      <div className="h-24 overflow-hidden rounded-lg border border-droid-border">{children}</div>
      <div className="mt-2 flex items-center justify-between px-0.5 pb-0.5">
        <span className={`text-[12px] ${active ? 'text-droid-text' : 'text-droid-text-secondary'}`}>
          {label}
        </span>
        {active && (
          <Check className="w-3.5 h-3.5" style={{ color: 'var(--droid-accent)' }} strokeWidth={3} />
        )}
      </div>
    </button>
  );
}

/* ── theme preset card ── */
function CardAction({
  title,
  danger = false,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-md p-1 transition-colors ${
        danger
          ? 'text-droid-red hover:bg-droid-red/10'
          : 'text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text'
      }`}
    >
      {children}
    </button>
  );
}

function ThemeCard({
  preset,
  active,
  activeScheme,
  isCustom,
  deleteArmed,
  onSelect,
  onDuplicate,
  onEdit,
  onExport,
  onDelete,
}: {
  preset: ThemePreset;
  active: boolean;
  activeScheme: 'light' | 'dark';
  isCustom: boolean;
  deleteArmed: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer rounded-xl border p-3.5 transition-colors ${
        active ? 'border-droid-accent' : 'border-droid-border hover:border-droid-border-hover'
      }`}
      style={active ? { boxShadow: '0 0 0 1px var(--droid-accent)' } : undefined}
    >
      <div className="flex justify-center py-2">
        <ThemeSwatches preset={preset} activeScheme={active ? activeScheme : undefined} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12.5px] text-droid-text">{preset.name}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          <CardAction title={`Duplicate ${preset.name}`} onClick={onDuplicate}>
            <Copy className="h-3.5 w-3.5" />
          </CardAction>
          {isCustom && onEdit && (
            <CardAction title={`Edit ${preset.name}`} onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </CardAction>
          )}
          {isCustom && onExport && (
            <CardAction title={`Export ${preset.name}`} onClick={onExport}>
              <Download className="h-3.5 w-3.5" />
            </CardAction>
          )}
          {isCustom && onDelete && (
            <CardAction
              title={deleteArmed ? 'Click again to delete' : `Delete ${preset.name}`}
              danger={deleteArmed}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </CardAction>
          )}
        </span>
      </div>
    </div>
  );
}

type EditorState =
  | { kind: 'create'; draft: ThemeDraft }
  | { kind: 'edit'; id: string; draft: ThemeDraft };

/* ── appearance content ── */
export function AppearanceSection() {
  const { state, dispatch } = useStore();
  const theme = state.theme;
  const customThemes = state.customThemes;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const activePreset = findPreset(theme.presetId, customThemes);
  // Palette behind the scheme cards: the active preset, or the default when
  // the current colors are hand-edited and match no preset.
  const previewPreset = activePreset ?? DEFAULT_THEME;
  const resolvedScheme: 'light' | 'dark' =
    theme.mode === 'light' ||
    (theme.mode === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light'
      : 'dark';

  const updateTheme = (patch: Partial<ThemeConfig>) => {
    dispatch({ type: 'SET_THEME', theme: patch });
    applyTheme({ ...theme, ...patch });
  };

  // Switching scheme re-resolves the active preset's other variant; hand-edited
  // (custom) colors have no second variant, so they stay as they are.
  const selectScheme = (mode: ThemeMode) => {
    updateTheme({ mode, ...(activePreset ? resolveVariant(activePreset, mode) : {}) });
  };

  const selectTheme = (preset: ThemePreset) => {
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

  const handleSave = (draft: ThemeDraft) => {
    const id = editor?.kind === 'edit' ? editor.id : newCustomThemeId();
    const preset: ThemePreset = { id, name: draft.name, light: draft.light, dark: draft.dark };
    dispatch({ type: 'SAVE_CUSTOM_THEME', preset });
    updateTheme({ presetId: id, ...resolveVariant(preset, theme.mode) });
    setEditor(null);
  };

  const handleDelete = (p: ThemePreset) => {
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
    if (!armedDeleteId) return;
    const timer = window.setTimeout(() => {
      setArmedDeleteId(null);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [armedDeleteId]);

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
        setImportError('That file is not a valid theme export.');
        return;
      }
      setImportError(null);
      // Open the editor so the import is previewed and named before saving.
      setEditor({ kind: 'create', draft: parsed });
    } catch {
      setImportError('Could not read that file — expected a JSON theme export.');
    }
  };

  const schemes = [
    { mode: 'system' as const, label: 'System', icon: Monitor },
    { mode: 'light' as const, label: 'Light', icon: Sun },
    { mode: 'dark' as const, label: 'Dark', icon: Moon },
  ];

  return (
    <div className="max-w-2xl mx-auto">
      <SectionTitle
        title="Appearance"
        sub="Choose how Droid Control looks. Use a built-in theme or make your own."
      />

      {/* Color scheme */}
      <GroupLabel>Color scheme</GroupLabel>
      <div className="grid grid-cols-3 gap-3 mb-8">
        {schemes.map(({ mode, label }) => (
          <SchemeCard
            key={mode}
            label={label}
            active={theme.mode === mode}
            onClick={() => {
              selectScheme(mode);
            }}
          >
            <SchemePreview preset={previewPreset} scheme={mode} />
          </SchemeCard>
        ))}
      </div>

      {/* Themes */}
      <div className="flex items-start justify-between gap-3">
        <GroupLabel>Themes</GroupLabel>
        <button
          type="button"
          onClick={() => {
            importInputRef.current?.click();
          }}
          className="flex items-center gap-1.5 rounded-md border border-droid-border px-2 py-1 text-[11px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
        >
          <Upload className="h-3 w-3" />
          Import
        </button>
      </div>
      {importError && <p className="mb-2 text-[11px] text-droid-red">{importError}</p>}
      <div className="grid grid-cols-2 gap-3 mb-8">
        {[...BUILT_IN_THEMES, ...customThemes].map((preset) => {
          const isCustom = customThemes.some((p) => p.id === preset.id);
          return (
            <ThemeCard
              key={preset.id}
              preset={preset}
              active={theme.presetId === preset.id}
              activeScheme={resolvedScheme}
              isCustom={isCustom}
              deleteArmed={armedDeleteId === preset.id}
              onSelect={() => {
                selectTheme(preset);
              }}
              onDuplicate={() => {
                openDuplicate(preset);
              }}
              onEdit={
                isCustom
                  ? () => {
                      openEdit(preset);
                    }
                  : undefined
              }
              onExport={
                isCustom
                  ? () => {
                      exportTheme(preset);
                    }
                  : undefined
              }
              onDelete={
                isCustom
                  ? () => {
                      if (armedDeleteId !== preset.id) {
                        setArmedDeleteId(preset.id);
                        return;
                      }
                      setArmedDeleteId(null);
                      handleDelete(preset);
                    }
                  : undefined
              }
            />
          );
        })}
        <button
          type="button"
          onClick={openNewTheme}
          className="flex min-h-[104px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-droid-border text-droid-text-muted transition-colors hover:border-droid-border-hover hover:text-droid-text"
        >
          <Plus className="h-4 w-4" />
          <span className="text-[12px]">New theme</span>
        </button>
      </div>

      {/* App icon */}
      <div className="rounded-xl border border-droid-border bg-droid-surface p-4 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] text-droid-text">App icon</div>
            <div className="text-[11px] text-droid-text-muted">
              Match the system, or pick the light or dark DROIDEX icon
            </div>
          </div>
          <div className="flex gap-1" role="group" aria-label="App icon">
            <ModeButton
              active={theme.appIconMode === 'light'}
              onClick={() => {
                updateTheme({ appIconMode: 'light' });
              }}
              icon={Sun}
              label="Light"
            />
            <ModeButton
              active={theme.appIconMode === 'dark'}
              onClick={() => {
                updateTheme({ appIconMode: 'dark' });
              }}
              icon={Moon}
              label="Dark"
            />
            <ModeButton
              active={theme.appIconMode === 'system'}
              onClick={() => {
                updateTheme({ appIconMode: 'system' });
              }}
              icon={Monitor}
              label="System"
            />
          </div>
        </div>
      </div>

      {/* Colors */}
      <GroupLabel>Colors</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface p-4 mb-6">
        <div className="space-y-3">
          <ColorField
            label="Accent"
            description="Highlights, active states, send button & design-mode controls"
            value={theme.accent}
            onChange={(v) => {
              updateColors({ accent: v });
            }}
          />
          <ColorField
            label="App background"
            description="The main window behind everything"
            value={theme.bg}
            onChange={(v) => {
              updateColors({ bg: v });
            }}
          />
          <ColorField
            label="Text color"
            description="Default color for all text"
            value={theme.fg}
            onChange={(v) => {
              updateColors({ fg: v });
            }}
          />
          <ColorField
            label="Panel background"
            description="Sidebar, cards and raised surfaces"
            value={theme.surface}
            onChange={(v) => {
              updateColors({ surface: v });
            }}
          />
          <ColorField
            label="Borders"
            description="Dividers and outlines between sections"
            value={theme.border}
            onChange={(v) => {
              updateColors({ border: v });
            }}
          />
        </div>
        <div className="mt-3.5 pt-3.5 border-t border-droid-border">
          <div className="text-[10.5px] text-droid-text-muted mb-2">Quick accents</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_ACCENTS.map((c) => (
              <ColorSwatch
                key={c}
                color={c}
                active={theme.accent.toLowerCase() === c.toLowerCase()}
                onClick={() => {
                  updateColors({ accent: c });
                }}
              />
            ))}
          </div>
        </div>
        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-droid-border pt-3.5">
          <div className="text-[10.5px] text-droid-text-muted">
            {theme.presetId === CUSTOM_THEME_ID
              ? 'These hand-tuned colors are an unsaved custom look.'
              : 'Tune any color, then keep it as your own theme.'}
          </div>
          <button
            type="button"
            onClick={openSaveCurrentAs}
            className="shrink-0 rounded-md border border-droid-border px-2 py-1 text-[11px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
          >
            Save as theme…
          </button>
        </div>
      </div>

      {/* Typography + behavior */}
      <GroupLabel>Typography & behavior</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface px-4 [&>*:last-child]:border-b-0">
        <div className="flex items-center justify-between py-2.5 border-b border-droid-border">
          <div>
            <div className="text-[13px] text-droid-text">UI font</div>
            <div className="text-[11px] text-droid-text-muted">
              Typeface for the whole app (defaults to your OS font)
            </div>
          </div>
          <Dropdown
            value={theme.uiFont}
            width="w-44"
            options={UI_FONTS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(v) => {
              updateTheme({ uiFont: v });
            }}
          />
        </div>
        <Slider
          label="UI font size"
          sub="Base size used across the Droid Control UI"
          value={theme.uiFontSize}
          min={12}
          max={18}
          onChange={(v) => {
            updateTheme({ uiFontSize: v });
          }}
          suffix="px"
        />
        <Slider
          label="Code font size"
          sub="Base size for code across chats and diffs"
          value={theme.codeFontSize}
          min={10}
          max={16}
          onChange={(v) => {
            updateTheme({ codeFontSize: v });
          }}
          suffix="px"
        />
        <Slider
          label="Contrast"
          sub="Adjust overall UI contrast"
          value={theme.contrast}
          min={40}
          max={100}
          onChange={(v) => {
            updateTheme({ contrast: v });
          }}
        />
        <Toggle
          label="Translucent sidebar"
          sub="Blur and lighten the sidebar surface"
          checked={theme.translucentSidebar}
          onChange={(v) => {
            updateTheme({ translucentSidebar: v });
          }}
        />
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
          onSave={handleSave}
          onCancel={() => {
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}

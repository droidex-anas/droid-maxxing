import { normalizeAppIconMode, type AppIconMode } from '../lib/appIcon';
import {
  DEFAULT_THEME_ID,
  detectPresetId,
  migrateLegacyLightPreset,
  parseCustomThemes,
  type ThemePreset,
} from '../lib/theme';

export type DiffStyle = 'soft' | 'focused';

export interface ThemeConfig {
  mode: 'dark' | 'light' | 'system';
  appIconMode: AppIconMode;
  // The preset the flattened colors came from: a built-in/custom theme id, or
  // 'custom' when the colors were edited by hand and match no preset.
  presetId: string;
  accent: string;
  bg: string;
  fg: string;
  surface: string;
  border: string;
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  diffStyle: DiffStyle;
  contrast: number;
}

const defaultTheme: ThemeConfig = {
  mode: 'dark',
  appIconMode: 'system',
  presetId: DEFAULT_THEME_ID,
  accent: '#f2f2f2',
  bg: '#0a0a0a',
  fg: '#ededed',
  surface: '#111111',
  border: '#1f1f1f',
  uiFont: 'system',
  uiFontSize: 14,
  codeFontSize: 12,
  translucentSidebar: false,
  diffStyle: 'soft',
  contrast: 100,
};

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

// Accents that shipped as the old fixed-orange default. A saved theme still
// carrying one of these was never deliberately colored by the user, so migrate
// it to a theme-matched neutral and let the monochrome scale show through.
const LEGACY_DEFAULT_ACCENTS = new Set(['#ee6018', '#ff5d2e']);
const THEME_ACCENT_MIGRATED_KEY = 'droid-theme-accent-migrated';
const THEME_LIGHT_PRESET_MIGRATED_KEY = 'droid-theme-light-preset-migrated';

function neutralAccentFor(bg: string): string {
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return Number.isFinite(lum) && lum >= 0.4 ? '#1a1a1a' : '#f2f2f2';
}

export function normalizeDiffStyle(value: unknown): DiffStyle {
  if (value === 'focused' || value === 'symbol') return 'focused';
  return 'soft';
}

const CUSTOM_THEMES_STORAGE_KEY = 'droid-theme-presets';

export function loadCustomThemes(): ThemePreset[] {
  try {
    const raw = getLocalStorage()?.getItem(CUSTOM_THEMES_STORAGE_KEY);
    return raw ? parseCustomThemes(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

// Persistence lives OUTSIDE the reducer: reducers must stay pure, and a throw
// from the root reducer would surface during render and unmount the app. The
// dispatching handler (ThemePresetCard) calls this BEFORE dispatching, so a
// write failure (quota, restricted storage) leaves live state untouched and
// surfaces as a retryable UI error instead of faking success. It throws on
// failure; callers must catch.
export function persistCustomThemes(presets: ThemePreset[]): void {
  getLocalStorage()?.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(presets));
}

// One-time migration: a saved accent still carrying an old fixed-orange
// default was never deliberately chosen, so neutralize it once. Keying off a
// persisted flag (not the accent value) lets a user later pick that same
// orange from the preset palette and have the choice stick across reloads.
function migrateLegacyAccent(storage: Storage, saved: string | null, theme: ThemeConfig): void {
  if (storage.getItem(THEME_ACCENT_MIGRATED_KEY) === '1') return;
  // Migration writes are isolated so a storage failure (quota/restricted)
  // never discards the theme we already parsed successfully above.
  try {
    if (saved && LEGACY_DEFAULT_ACCENTS.has(theme.accent.toLowerCase())) {
      theme.accent = neutralAccentFor(theme.bg);
      storage.setItem('droid-theme', JSON.stringify(theme));
    }
    storage.setItem(THEME_ACCENT_MIGRATED_KEY, '1');
  } catch {
    /* migration write failed; retry on a later load */
  }
}

// One-time migration: a saved theme still matching the old white-on-white
// light preset exactly was never customized, so swap it to the readable
// warm-grey palette. Same persisted-flag pattern as the accent migration.
function migrateLegacyLight(storage: Storage, saved: string | null, theme: ThemeConfig): void {
  if (storage.getItem(THEME_LIGHT_PRESET_MIGRATED_KEY) === '1') return;
  try {
    if (saved) {
      const migrated = migrateLegacyLightPreset(theme);
      if (migrated !== theme) {
        theme.bg = migrated.bg;
        theme.fg = migrated.fg;
        theme.surface = migrated.surface;
        theme.border = migrated.border;
        theme.accent = migrated.accent;
        storage.setItem('droid-theme', JSON.stringify(theme));
      }
    }
    storage.setItem(THEME_LIGHT_PRESET_MIGRATED_KEY, '1');
  } catch {
    /* migration write failed; retry on a later load */
  }
}

export function loadTheme(customThemes: ThemePreset[]): ThemeConfig {
  try {
    const storage = getLocalStorage();
    const saved = storage?.getItem('droid-theme') ?? null;
    const parsed: unknown = saved ? JSON.parse(saved) : null;
    const theme =
      parsed && typeof parsed === 'object'
        ? { ...defaultTheme, ...(parsed as Partial<ThemeConfig>) }
        : { ...defaultTheme };
    theme.diffStyle = normalizeDiffStyle(theme.diffStyle);
    theme.appIconMode = normalizeAppIconMode(theme.appIconMode);
    // Migrations run BEFORE preset detection: a legacy palette migrated onto
    // the default variant must come out with the default's presetId, not
    // 'custom' — otherwise Dark/System can never resolve its other variant.
    if (storage) {
      migrateLegacyAccent(storage, saved, theme);
      migrateLegacyLight(storage, saved, theme);
    }
    // Themes saved before presets existed have no presetId: recover it by
    // matching the saved colors against known variants, else label them custom.
    const savedPresetId = (parsed as { presetId?: unknown } | null)?.presetId;
    theme.presetId =
      typeof savedPresetId === 'string' && savedPresetId
        ? savedPresetId
        : detectPresetId(theme, customThemes);
    return theme;
  } catch {
    /* ignore */
  }
  return defaultTheme;
}

export function persistTheme(theme: ThemeConfig): void {
  try {
    getLocalStorage()?.setItem('droid-theme', JSON.stringify(theme));
  } catch {
    /* ignore */
  }
}

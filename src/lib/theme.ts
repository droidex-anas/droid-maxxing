import { diffPaletteForTheme } from './diffTheme';

// The five colors every theme is built from; applyTheme derives the rest of
// the ramp (elevated/active/borders/secondary/muted/shadow) from these.
export interface ThemeColors {
  bg: string;
  fg: string;
  surface: string;
  border: string;
  accent: string;
}

export type ThemeMode = 'dark' | 'light' | 'system';

// Structural view of the persisted theme that applyTheme needs. Matches
// ThemeConfig in useStore without importing it (store -> theme one-way dep).
export interface ThemeSettings extends ThemeColors {
  diffStyle: 'soft' | 'focused';
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  contrast: number;
}

// A named theme with a light and a dark variant. The color scheme setting
// (light/dark/system) picks which variant of the active preset is applied.
export interface ThemePreset {
  id: string;
  name: string;
  light: ThemeColors;
  dark: ThemeColors;
}

// Sentinel presetId for flattened colors that match no preset (manual edits).
export const CUSTOM_THEME_ID = 'custom';
export const DEFAULT_THEME_ID = 'droid';

// Each preset carries a theme-matched neutral accent so switching scheme/preset
// keeps the UI monochrome (the accent tracks the foreground tone) instead of
// leaving a stale colored accent behind. Tinted themes use their own fg tone
// as the accent so they stay on a single tonal scale. The branded presets
// (Claude, VS Code, ChatGPT, Catppuccin, Tokyo Night) instead carry their
// signature accent color, tuned per variant so it reads on its own canvas.
//
// Light variants are deliberately NOT white-on-white: a warm grey canvas with
// near-white surfaces gives the same tonal depth dark mode has (cards and
// hover states stay visible), keeps near-black text from glaring, and lets the
// pastel diff palettes read. Each variant carries a hue-matched tint (warm
// paper for Droid, cool blue for Midnight, etc.) and a softened, slightly
// warm foreground instead of a harsh neutral, so the whole scale sits gently
// on the eye — pure-white backgrounds and black text are tiring and flatten
// every border.
// Non-empty tuple so the default entry (index 0) is statically defined.
export const BUILT_IN_THEMES: [ThemePreset, ...ThemePreset[]] = [
  {
    id: DEFAULT_THEME_ID,
    name: 'Default',
    dark: {
      bg: '#0a0a0a',
      fg: '#ededed',
      surface: '#111111',
      border: '#1f1f1f',
      accent: '#f2f2f2',
    },
    light: {
      bg: '#efede8',
      fg: '#2e2b26',
      surface: '#faf8f4',
      border: '#e2ded6',
      accent: '#2e2b26',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dark: {
      bg: '#0a0e1a',
      fg: '#c8d0e0',
      surface: '#11152a',
      border: '#1a2040',
      accent: '#c8d0e0',
    },
    light: {
      bg: '#e9ecf2',
      fg: '#2a3040',
      surface: '#f8f9fb',
      border: '#d9dde6',
      accent: '#2a3040',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    dark: {
      bg: '#1a1612',
      fg: '#d8d0c8',
      surface: '#221e18',
      border: '#322a22',
      accent: '#d8d0c8',
    },
    light: {
      bg: '#f1ebe2',
      fg: '#362e26',
      surface: '#faf5ee',
      border: '#e4dacb',
      accent: '#362e26',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    dark: {
      bg: '#081318',
      fg: '#c2d4dc',
      surface: '#0d1b22',
      border: '#1a2e39',
      accent: '#c2d4dc',
    },
    light: {
      bg: '#e6edee',
      fg: '#25353c',
      surface: '#f7fafb',
      border: '#d5dfe2',
      accent: '#25353c',
    },
  },
  {
    id: 'violet',
    name: 'Violet',
    dark: {
      bg: '#120e1c',
      fg: '#d2cbe8',
      surface: '#1a1428',
      border: '#2a2140',
      accent: '#d2cbe8',
    },
    light: {
      bg: '#edeaf3',
      fg: '#322b44',
      surface: '#f9f8fb',
      border: '#dfd9e9',
      accent: '#322b44',
    },
  },
  // Anthropic's Claude: warm book-cloth ivory / warm ink, terracotta accent.
  // The light accent is a deepened terracotta so links and active states keep
  // ~4.6:1 on the ivory canvas; dark keeps the brand orange (#d97757).
  {
    id: 'claude',
    name: 'Claude',
    dark: {
      bg: '#141413',
      fg: '#ede9e3',
      surface: '#1e1d1b',
      border: '#2e2c29',
      accent: '#d97757',
    },
    light: {
      bg: '#edebe3',
      fg: '#141413',
      surface: '#f7f5ee',
      border: '#dcd7ca',
      accent: '#a84a28',
    },
  },
  // VS Code Dark+/Light+: the familiar editor greys with the status-bar blue,
  // lightened/darkened per variant so accent text keeps >=4.5:1 on its canvas.
  {
    id: 'vscode',
    name: 'VS Code',
    dark: {
      bg: '#1e1e1e',
      fg: '#d4d4d4',
      surface: '#252526',
      border: '#3c3c3c',
      accent: '#3794ff',
    },
    light: {
      bg: '#ecedf0',
      fg: '#1f1f1f',
      surface: '#f8f9fb',
      border: '#d6d8de',
      accent: '#0066aa',
    },
  },
  // ChatGPT/Codex: strictly monochrome mid-greys; the accent is the send-button
  // white/black, like the real app.
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    dark: {
      bg: '#212121',
      fg: '#ececec',
      surface: '#2f2f2f',
      border: '#424242',
      accent: '#f5f5f5',
    },
    light: {
      bg: '#ededec',
      fg: '#0d0d0d',
      surface: '#f9f9f8',
      border: '#dcdcda',
      accent: '#0d0d0d',
    },
  },
  // Catppuccin Mocha/Latte with the signature mauve accent. The Latte text and
  // canvas are deepened a step so body text keeps >=7:1 on tinted paper.
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    dark: {
      bg: '#1e1e2e',
      fg: '#cdd6f4',
      surface: '#313244',
      border: '#45475a',
      accent: '#cba6f7',
    },
    light: {
      bg: '#e8eaf0',
      fg: '#40435c',
      surface: '#f5f6fa',
      border: '#ccd0dc',
      accent: '#8839ef',
    },
  },
  // Tokyo Night (Night/Day): deep blue-grey canvas with the signature blue.
  // The Day accent is darkened so accent text keeps >=4.5:1 on its canvas.
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    dark: {
      bg: '#1a1b26',
      fg: '#c0caf5',
      surface: '#24283b',
      border: '#3b4261',
      accent: '#7aa2f7',
    },
    light: {
      bg: '#e1e2e7',
      fg: '#343b58',
      surface: '#eceef3',
      border: '#c4c8d4',
      accent: '#0066aa',
    },
  },
];

export const DEFAULT_THEME: ThemePreset = BUILT_IN_THEMES[0];

export function findPreset(id: string, customThemes: ThemePreset[]): ThemePreset | undefined {
  return BUILT_IN_THEMES.find((p) => p.id === id) ?? customThemes.find((p) => p.id === id);
}

// Resolve the on-screen scheme for a mode: 'system' follows the OS preference
// (dark when no preference is readable, e.g. in tests). Shared by every place
// that needs the visible scheme so the media query lives in exactly one spot.
export function resolveScheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'light' ||
    (mode === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches)
    ? 'light'
    : 'dark';
}

// Resolve which variant of a preset a scheme mode selects.
export function resolveVariant(preset: ThemePreset, mode: ThemeMode): ThemeColors {
  return resolveScheme(mode) === 'light' ? preset.light : preset.dark;
}

function sameColors(a: ThemeColors, b: ThemeColors): boolean {
  return (Object.keys(a) as (keyof ThemeColors)[]).every(
    (key) => a[key].toLowerCase() === b[key].toLowerCase(),
  );
}

// Identify the preset a flattened palette came from (either variant matches).
// Used to label themes saved before presetId existed; unmatched colors are
// reported as CUSTOM_THEME_ID.
export function detectPresetId(colors: ThemeColors, customThemes: ThemePreset[] = []): string {
  for (const preset of [...BUILT_IN_THEMES, ...customThemes]) {
    if (sameColors(preset.light, colors) || sameColors(preset.dark, colors)) return preset.id;
  }
  return CUSTOM_THEME_ID;
}

/* ── custom preset persistence + import ── */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function readColors(value: unknown): ThemeColors | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const colors = {
    bg: raw['bg'],
    fg: raw['fg'],
    surface: raw['surface'],
    border: raw['border'],
    accent: raw['accent'],
  };
  for (const v of Object.values(colors)) {
    if (typeof v !== 'string' || !HEX_COLOR.test(v)) return null;
  }
  return colors as ThemeColors;
}

function readPresetName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 60);
  return name ? name : null;
}

// Add a custom preset, replacing any existing entry with the same id. Shared
// by the store reducer and the UI handler that persists first, so both always
// compute the same list.
export function upsertCustomTheme(themes: ThemePreset[], preset: ThemePreset): ThemePreset[] {
  return themes.some((p) => p.id === preset.id)
    ? themes.map((p) => (p.id === preset.id ? preset : p))
    : [...themes, preset];
}

export function removeCustomTheme(themes: ThemePreset[], id: string): ThemePreset[] {
  return themes.filter((p) => p.id !== id);
}

// Validate the persisted custom-theme list, dropping malformed entries so a
// corrupt payload never blocks the built-ins.
export function parseCustomThemes(raw: unknown): ThemePreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: ThemePreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, light, dark } = entry as Record<string, unknown>;
    const colors = { light: readColors(light), dark: readColors(dark) };
    const label = readPresetName(name);
    if (typeof id !== 'string' || !id || !label || !colors.light || !colors.dark) continue;
    presets.push({ id, name: label, light: colors.light, dark: colors.dark });
  }
  return presets;
}

// Validate an imported theme file ({ name, light, dark }). The preset gets a
// fresh id when the import is saved.
export function parseThemePresetImport(
  raw: unknown,
): { name: string; light: ThemeColors; dark: ThemeColors } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, light, dark } = raw as Record<string, unknown>;
  const label = readPresetName(name);
  const lightColors = readColors(light);
  const darkColors = readColors(dark);
  if (!label || !lightColors || !darkColors) return null;
  return { name: label, light: lightColors, dark: darkColors };
}

export function newCustomThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// The light preset as it shipped before the readability pass. A saved theme
// still carrying all five legacy values was never customized, so it is swapped
// to the new preset once on load (see useStore loadTheme).
const LEGACY_LIGHT_PRESET: ThemeColors = {
  bg: '#fcfcfc',
  fg: '#141414',
  surface: '#f3f3f3',
  border: '#eeeeee',
  accent: '#1a1a1a',
};

export function migrateLegacyLightPreset(colors: ThemeColors): ThemeColors {
  const isLegacy = (Object.keys(LEGACY_LIGHT_PRESET) as (keyof ThemeColors)[]).every(
    (key) => colors[key].toLowerCase() === LEGACY_LIGHT_PRESET[key],
  );
  return isLegacy ? { ...DEFAULT_THEME.light } : colors;
}

const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const UI_FONTS: { id: string; label: string; stack: string }[] = [
  { id: 'system', label: 'System', stack: SYSTEM_FONT_STACK },
  { id: 'inter', label: 'Inter', stack: `"Inter", ${SYSTEM_FONT_STACK}` },
  { id: 'sf', label: 'SF Pro', stack: `"SF Pro Display", "SF Pro Text", ${SYSTEM_FONT_STACK}` },
  { id: 'geist', label: 'Geist', stack: `"Geist", ${SYSTEM_FONT_STACK}` },
  { id: 'helvetica', label: 'Helvetica', stack: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  { id: 'georgia', label: 'Georgia', stack: `Georgia, "Times New Roman", serif` },
  { id: 'mono', label: 'Mono', stack: `"JetBrains Mono", "Fira Code", ui-monospace, monospace` },
];

export function uiFontStack(id: string): string {
  return UI_FONTS.find((f) => f.id === id)?.stack ?? SYSTEM_FONT_STACK;
}

/* ── apply CSS variables to document ── */
export function applyTheme(theme: ThemeSettings) {
  const root = document.documentElement;
  root.style.setProperty('--droid-bg', theme.bg);
  root.style.setProperty('--droid-surface', theme.surface);
  // Build the elevation ramp in the correct direction for the theme. Dark themes
  // get lighter as surfaces rise (bg < surface < elevated < active); light themes
  // step progressively darker, since there is no headroom above a near-white base
  // (e.g. surface #f3f3f3 over bg #fcfcfc). This keeps a real, visible tonal
  // hierarchy in both modes instead of an inverted/flat ramp.
  const bgIsDark = colorLuminance(theme.bg) < 0.4;
  const lift = (amount: number) => adjustColor(theme.surface, bgIsDark ? amount : -amount);
  root.style.setProperty('--droid-elevated', lift(13));
  // Input fields inside cards: lifted like elevated on dark (reads as a raised
  // pad), plain surface on light so fields stay crisp on the tinted card
  // instead of stepping darker into a grey smudge.
  root.style.setProperty('--droid-field', bgIsDark ? lift(13) : theme.surface);
  // The most-raised neutral, for selected/active rows.
  root.style.setProperty('--droid-active', lift(26));
  // Soften resting borders by blending toward the background so panel/section
  // separators read as gentle hairlines rather than hard lines. Dark themes need
  // a stronger blend: at low luminance the same edge reads as a harsh outline, so
  // we push it closer to the background to keep the subtle look light mode has.
  root.style.setProperty('--droid-border', mixHex(theme.border, theme.bg, bgIsDark ? 0.72 : 0.6));
  root.style.setProperty(
    '--droid-border-hover',
    mixHex(theme.border, theme.bg, bgIsDark ? 0.4 : 0.2),
  );
  root.style.setProperty('--droid-text', theme.fg);
  if (bgIsDark) {
    root.style.setProperty('--droid-text-secondary', adjustColor(theme.fg, -30));
    root.style.setProperty('--droid-text-muted', adjustColor(theme.fg, -50));
  } else {
    // Light themes have no dark headroom below a near-black fg (darkening would
    // invert the hierarchy into pure black), so mute by blending toward the
    // canvas: secondary ~4.4:1 on white, muted reserved for placeholders.
    root.style.setProperty('--droid-text-secondary', mixHex(theme.fg, theme.bg, 0.42));
    root.style.setProperty('--droid-text-muted', mixHex(theme.fg, theme.bg, 0.62));
  }
  root.style.setProperty('--droid-accent', theme.accent);
  // Floating-card shadow: strong and near-black on dark where it separates
  // surfaces, soft and diffuse on light so cards lift without looking dirty.
  root.style.setProperty(
    '--droid-shadow',
    bgIsDark ? '0 10px 40px rgba(0, 0, 0, 0.35)' : '0 10px 30px rgba(28, 25, 23, 0.1)',
  );
  // Semantic status colors are FIXED, never accent-derived, so success/warning
  // and diff add/remove always read as green/amber/red even when the accent is a
  // neutral monochrome tone.
  root.style.setProperty('--droid-green', '#4fae82');
  root.style.setProperty('--droid-orange', '#d9913a');
  root.style.setProperty('--droid-red', '#cf5d54');
  root.setAttribute('data-diff-style', theme.diffStyle);
  const diffPalette = diffPaletteForTheme(bgIsDark, theme.diffStyle);
  root.style.setProperty('--diff-add-fg', diffPalette.addFg);
  root.style.setProperty('--diff-add-bg', diffPalette.addBg);
  root.style.setProperty('--diff-add-gutter', diffPalette.addGutter);
  root.style.setProperty('--diff-del-fg', diffPalette.delFg);
  root.style.setProperty('--diff-del-bg', diffPalette.delBg);
  root.style.setProperty('--diff-del-gutter', diffPalette.delGutter);
  root.style.setProperty('--diff-hunk-bg', diffPalette.hunkBg);
  root.style.setProperty('--diff-hunk-fg', diffPalette.hunkFg);

  root.style.setProperty('--ui-font-family', uiFontStack(theme.uiFont));
  root.style.setProperty('--ui-font-size', `${String(theme.uiFontSize)}px`);
  // The UI is built with fixed px text sizes, so scale the whole app relative
  // to the 14px baseline to make the size slider take visible effect.
  root.style.setProperty('--ui-zoom', String(theme.uiFontSize / 14));
  root.style.setProperty('--code-font-size', `${String(theme.codeFontSize)}px`);

  // Dedicated sidebar surface so translucency only affects the sidebar. When
  // enabled, the window becomes transparent (see index.css + Electron vibrancy)
  // and the sidebar uses a semi-transparent fill so the wallpaper behind the
  // window shows through a little — frosted, not fully clear.
  // Light surfaces sit over a dark macOS vibrancy material, so a low-opacity
  // fill plus a strong saturation boost lets the wallpaper bleed through as a
  // muddy tint. Keep light themes mostly opaque with gentle saturation so the
  // sidebar stays a clean frosted white; dark themes can show more through.
  root.setAttribute('data-translucent', theme.translucentSidebar ? 'true' : 'false');
  const sidebarAlpha = bgIsDark ? '99' : 'f2';
  const sidebarSaturate = bgIsDark ? 'saturate(150%)' : 'saturate(108%)';
  root.style.setProperty(
    '--sidebar-bg',
    theme.translucentSidebar ? `${theme.surface}${sidebarAlpha}` : theme.surface,
  );
  root.style.setProperty(
    '--sidebar-blur',
    theme.translucentSidebar ? `blur(6px) ${sidebarSaturate}` : 'none',
  );

  // Apply contrast as a filter only below 100% so it never creates a stacking
  // context that would defeat the sidebar's backdrop blur at the default value.
  const rootEl = document.getElementById('root');
  if (rootEl)
    rootEl.style.filter = theme.contrast >= 100 ? '' : `contrast(${String(theme.contrast)}%)`;
}

/* ── tiny color utils ── */
// Relative luminance (0 = black, 1 = white) used to tell dark themes from light.
function colorLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function adjustColor(hex: string, lighten: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = (n: number) => Math.max(0, Math.min(255, n + lighten));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`;
}

// Blend `hex` toward `target` by t (0..1).
function mixHex(hex: string, target: string, t: number): string {
  const parse = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(mix(r1, r2))}${toHex(mix(g1, g2))}${toHex(mix(b1, b2))}`;
}

// sRGB channel -> linear-light value, for WCAG contrast checks.
function linearChannel(hexPair: string): number {
  const c = parseInt(hexPair, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// WCAG relative luminance (0 = black, 1 = white).
export function relativeLuminance(hex: string): number {
  return (
    0.2126 * linearChannel(hex.slice(1, 3)) +
    0.7152 * linearChannel(hex.slice(3, 5)) +
    0.0722 * linearChannel(hex.slice(5, 7))
  );
}

// WCAG contrast ratio between two hex colors (1..21).
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

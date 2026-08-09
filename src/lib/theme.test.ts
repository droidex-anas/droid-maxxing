import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_THEMES,
  contrastRatio,
  CUSTOM_THEME_ID,
  DEFAULT_THEME,
  detectPresetId,
  findPreset,
  migrateLegacyLightPreset,
  newCustomThemeId,
  parseCustomThemes,
  parseThemePresetImport,
  relativeLuminance,
  removeCustomTheme,
  resolveScheme,
  resolveVariant,
  uiFontStack,
  upsertCustomTheme,
  type ThemeColors,
  type ThemePreset,
} from './theme';

const LEGACY_LIGHT: ThemeColors = {
  bg: '#fcfcfc',
  fg: '#141414',
  surface: '#f3f3f3',
  border: '#eeeeee',
  accent: '#1a1a1a',
};

const EXAMPLE_CUSTOM: ThemePreset = {
  id: 'custom-test',
  name: 'Test Theme',
  light: { bg: '#f0f0f0', fg: '#101010', surface: '#ffffff', border: '#dddddd', accent: '#181818' },
  dark: { bg: '#101010', fg: '#f0f0f0', surface: '#181818', border: '#282828', accent: '#e8e8e8' },
};

describe('BUILT_IN_THEMES', () => {
  it('keeps every variant of every preset on valid 6-digit hex colors', () => {
    for (const preset of BUILT_IN_THEMES) {
      for (const variant of [preset.light, preset.dark]) {
        for (const value of Object.values(variant)) {
          assert.match(value, /^#[0-9a-f]{6}$/i, `${preset.id} has an invalid color`);
        }
      }
    }
  });

  it('has unique ids and a default theme', () => {
    const ids = BUILT_IN_THEMES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(DEFAULT_THEME.id, 'droid');
  });

  it('light canvases are tinted (not near-white) with surfaces above them', () => {
    for (const preset of BUILT_IN_THEMES) {
      const { bg, surface } = preset.light;
      assert.ok(
        relativeLuminance(bg) < 0.86,
        `${preset.id} light bg ${bg} should sit below searing white`,
      );
      assert.ok(
        relativeLuminance(surface) > relativeLuminance(bg),
        `${preset.id} surfaces must lift above the canvas`,
      );
    }
  });

  it('keeps foreground text comfortably readable on every variant', () => {
    // Softened (non-black) foregrounds are intentional, but they must stay well
    // above WCAG AA's 4.5:1 for normal text on both canvas and raised surfaces.
    for (const preset of BUILT_IN_THEMES) {
      for (const variant of [preset.light, preset.dark]) {
        for (const surface of [variant.bg, variant.surface]) {
          assert.ok(
            contrastRatio(variant.fg, surface) >= 7,
            `${preset.id} fg ${variant.fg} on ${surface} should reach 7:1`,
          );
        }
      }
    }
  });

  it('keeps accent-colored text at WCAG AA on every variant', () => {
    // Accents appear as text (links, active labels), so each must reach 4.5:1
    // for normal text on both the canvas and raised surfaces of its variant.
    for (const preset of BUILT_IN_THEMES) {
      for (const variant of [preset.light, preset.dark]) {
        for (const surface of [variant.bg, variant.surface]) {
          assert.ok(
            contrastRatio(variant.accent, surface) >= 4.5,
            `${preset.id} accent ${variant.accent} on ${surface} should reach 4.5:1`,
          );
        }
      }
    }
  });
});

describe('custom theme list helpers', () => {
  it('upsertCustomTheme appends or replaces by id without mutating the input', () => {
    const list = [EXAMPLE_CUSTOM];
    const appended = upsertCustomTheme(list, { ...EXAMPLE_CUSTOM, id: 'custom-two' });
    assert.deepEqual(
      appended.map((p) => p.id),
      ['custom-test', 'custom-two'],
    );
    const replaced = upsertCustomTheme(list, { ...EXAMPLE_CUSTOM, name: 'Renamed' });
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].name, 'Renamed');
    assert.equal(list[0].name, 'Test Theme');
  });

  it('removeCustomTheme drops only the matching id', () => {
    const list = [EXAMPLE_CUSTOM, { ...EXAMPLE_CUSTOM, id: 'custom-two' }];
    assert.deepEqual(
      removeCustomTheme(list, 'custom-test').map((p) => p.id),
      ['custom-two'],
    );
    assert.equal(removeCustomTheme(list, 'nope').length, 2);
  });
});

describe('findPreset', () => {
  it('finds built-ins and custom presets by id', () => {
    assert.equal(findPreset('midnight', [])?.name, 'Midnight');
    assert.equal(findPreset('custom-test', [EXAMPLE_CUSTOM]), EXAMPLE_CUSTOM);
  });

  it('returns undefined for unknown ids (including the custom sentinel)', () => {
    assert.equal(findPreset(CUSTOM_THEME_ID, []), undefined);
    assert.equal(findPreset('nope', [EXAMPLE_CUSTOM]), undefined);
  });
});

describe('resolveVariant', () => {
  it('returns the matching variant for explicit schemes', () => {
    assert.equal(resolveVariant(DEFAULT_THEME, 'light'), DEFAULT_THEME.light);
    assert.equal(resolveVariant(DEFAULT_THEME, 'dark'), DEFAULT_THEME.dark);
  });

  it('falls back to the dark variant for system when no preference is readable', () => {
    // node:test has no window, so matchMedia is unavailable.
    assert.equal(resolveVariant(DEFAULT_THEME, 'system'), DEFAULT_THEME.dark);
  });
});

describe('resolveScheme', () => {
  it('passes explicit schemes through and falls back to dark for system', () => {
    // node:test has no window, so matchMedia is unavailable.
    assert.equal(resolveScheme('light'), 'light');
    assert.equal(resolveScheme('dark'), 'dark');
    assert.equal(resolveScheme('system'), 'dark');
  });
});

describe('detectPresetId', () => {
  it('matches built-in variants exactly', () => {
    assert.equal(detectPresetId({ ...DEFAULT_THEME.dark }), DEFAULT_THEME.id);
    assert.equal(detectPresetId({ ...BUILT_IN_THEMES[1].light }), BUILT_IN_THEMES[1].id);
  });

  it('matches case-insensitively', () => {
    const upper = { ...DEFAULT_THEME.dark, bg: DEFAULT_THEME.dark.bg.toUpperCase() };
    assert.equal(detectPresetId(upper), DEFAULT_THEME.id);
  });

  it('matches custom presets and reports unmatched colors as custom', () => {
    assert.equal(detectPresetId({ ...EXAMPLE_CUSTOM.dark }, [EXAMPLE_CUSTOM]), EXAMPLE_CUSTOM.id);
    assert.equal(
      detectPresetId({ ...DEFAULT_THEME.dark, accent: '#ee6018' }, [EXAMPLE_CUSTOM]),
      CUSTOM_THEME_ID,
    );
  });
});

describe('migrateLegacyLightPreset', () => {
  it('swaps an exact legacy light theme to the new preset', () => {
    assert.deepEqual(migrateLegacyLightPreset({ ...LEGACY_LIGHT }), DEFAULT_THEME.light);
  });

  it('matches legacy values case-insensitively', () => {
    assert.deepEqual(
      migrateLegacyLightPreset({ ...LEGACY_LIGHT, bg: '#FCFCFC' }),
      DEFAULT_THEME.light,
    );
  });

  it('leaves a customized light theme untouched (same reference)', () => {
    const custom = { ...LEGACY_LIGHT, accent: '#ee6018' };
    assert.equal(migrateLegacyLightPreset(custom), custom);
  });

  it('leaves non-light themes untouched', () => {
    assert.equal(migrateLegacyLightPreset(DEFAULT_THEME.dark), DEFAULT_THEME.dark);
  });
});

describe('parseCustomThemes', () => {
  it('parses a valid persisted list', () => {
    assert.deepEqual(parseCustomThemes([EXAMPLE_CUSTOM]), [EXAMPLE_CUSTOM]);
  });

  it('drops malformed entries and non-array payloads', () => {
    assert.deepEqual(parseCustomThemes(null), []);
    assert.deepEqual(parseCustomThemes('nope'), []);
    assert.deepEqual(
      parseCustomThemes([
        EXAMPLE_CUSTOM,
        { id: 'x', name: 'Missing variants' },
        { id: '', name: 'No id', light: EXAMPLE_CUSTOM.light, dark: EXAMPLE_CUSTOM.dark },
        {
          id: 'y',
          name: 'Bad hex',
          light: { ...EXAMPLE_CUSTOM.light, bg: 'red' },
          dark: EXAMPLE_CUSTOM.dark,
        },
        null,
      ]),
      [EXAMPLE_CUSTOM],
    );
  });

  it('trims and rejects empty names', () => {
    const [parsed] = parseCustomThemes([{ ...EXAMPLE_CUSTOM, name: '  Padded  ' }]);
    assert.equal(parsed.name, 'Padded');
    assert.deepEqual(parseCustomThemes([{ ...EXAMPLE_CUSTOM, name: '   ' }]), []);
  });
});

describe('parseThemePresetImport', () => {
  it('accepts a valid export payload', () => {
    const payload = {
      name: EXAMPLE_CUSTOM.name,
      light: EXAMPLE_CUSTOM.light,
      dark: EXAMPLE_CUSTOM.dark,
    };
    assert.deepEqual(parseThemePresetImport(payload), payload);
  });

  it('rejects invalid payloads', () => {
    assert.equal(parseThemePresetImport(null), null);
    assert.equal(parseThemePresetImport({ name: 'x' }), null);
    assert.equal(
      parseThemePresetImport({ name: 'x', light: EXAMPLE_CUSTOM.light, dark: { bg: '#000000' } }),
      null,
    );
  });
});

describe('newCustomThemeId', () => {
  it('generates unique custom-prefixed ids', () => {
    const a = newCustomThemeId();
    const b = newCustomThemeId();
    assert.match(a, /^custom-/);
    assert.notEqual(a, b);
  });
});

describe('uiFontStack', () => {
  it('falls back to the system stack for unknown ids', () => {
    assert.match(uiFontStack('nope'), /system-ui/);
  });
});

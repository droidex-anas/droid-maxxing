import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, type ThemeColors, type ThemePreset } from '../lib/theme';
import { loadTheme } from './persistedThemePreferences';
import { loadAgentConfig, sanitizeAgentConfig } from './persistedUiPreferences';
import type { ModelInfo } from '../types/bridge';

const LEGACY_LIGHT: ThemeColors = {
  bg: '#fcfcfc',
  fg: '#141414',
  surface: '#f3f3f3',
  border: '#eeeeee',
  accent: '#1a1a1a',
};

const CUSTOM_PRESET: ThemePreset = {
  id: 'custom-test',
  name: 'Test',
  light: { bg: '#f0f0f0', fg: '#101010', surface: '#ffffff', border: '#dddddd', accent: '#181818' },
  dark: { bg: '#101010', fg: '#f0f0f0', surface: '#181818', border: '#282828', accent: '#e8e8e8' },
};

test('legacy accent migration neutralizes old default orange and writes migration flags', () => {
  withLocalStorageMap(
    {
      'droid-theme': JSON.stringify({
        ...DEFAULT_THEME.dark,
        accent: '#ee6018',
        presetId: 'default',
      }),
    },
    () => {
      const theme = loadTheme([]);
      assert.notEqual(theme.accent.toLowerCase(), '#ee6018');
      assert.equal(globalThis.localStorage?.getItem('droid-theme-accent-migrated'), '1');
      const persisted = JSON.parse(globalThis.localStorage?.getItem('droid-theme') ?? '{}') as {
        accent?: string;
      };
      assert.notEqual(persisted.accent?.toLowerCase(), '#ee6018');
    },
  );
});

test('legacy light migration rewrites the old white preset and writes migration flags', () => {
  withLocalStorageMap(
    {
      'droid-theme': JSON.stringify({ ...LEGACY_LIGHT, presetId: 'default' }),
    },
    () => {
      const theme = loadTheme([]);
      assert.equal(theme.bg, DEFAULT_THEME.light.bg);
      assert.equal(globalThis.localStorage?.getItem('droid-theme-light-preset-migrated'), '1');
      const persisted = JSON.parse(globalThis.localStorage?.getItem('droid-theme') ?? '{}') as {
        bg?: string;
      };
      assert.equal(persisted.bg, DEFAULT_THEME.light.bg);
    },
  );
});

test('loadTheme resolves presetId from saved colors and custom presets', () => {
  withLocalStorageMap(
    {
      'droid-theme': JSON.stringify({
        ...CUSTOM_PRESET.dark,
        presetId: '',
      }),
    },
    () => {
      const theme = loadTheme([CUSTOM_PRESET]);
      assert.equal(theme.presetId, 'custom-test');
    },
  );
});

test('malformed agent config sanitizes to defaults', () => {
  withLocalStorageMap(
    {
      'droid-agent-config-v2': JSON.stringify({
        primary: { modelId: 42, reasoning: 'bogus' },
        worker: null,
        validator: { modelId: '', reasoning: 'high' },
      }),
    },
    () => {
      assert.deepEqual(loadAgentConfig(), {
        primary: { modelId: undefined, reasoning: 'high' },
        worker: { modelId: undefined, reasoning: 'medium' },
        validator: { modelId: undefined, reasoning: 'high' },
      });
    },
  );
});

test('sanitizeAgentConfig drops unknown models and coerces unsupported reasoning', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-a',
      displayName: 'Model A',
      isCustom: false,
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
    },
  ];
  const config = {
    primary: { modelId: 'model-a', reasoning: 'max' as const },
    worker: { modelId: 'missing', reasoning: 'medium' as const },
    validator: { modelId: undefined, reasoning: 'medium' as const },
  };
  assert.deepEqual(sanitizeAgentConfig(config, models), {
    primary: { modelId: 'model-a', reasoning: 'low' },
    worker: { modelId: undefined, reasoning: 'medium' },
    validator: { modelId: undefined, reasoning: 'medium' },
  });
});

function withLocalStorageMap(
  seed: Record<string, string> | Map<string, string>,
  fn: () => void,
): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = seed instanceof Map ? seed : new Map(Object.entries(seed));
  const mock: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, next) => {
      values.set(key, next);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: mock,
  });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

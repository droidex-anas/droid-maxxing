import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer } from './useStore';
import { persistCustomThemes } from './persistedThemePreferences';
import type { ThemePreset } from '../lib/theme';

const PRESET: ThemePreset = {
  id: 'custom-one',
  name: 'One',
  light: { bg: '#f0f0f0', fg: '#101010', surface: '#ffffff', border: '#dddddd', accent: '#181818' },
  dark: { bg: '#101010', fg: '#f0f0f0', surface: '#181818', border: '#282828', accent: '#e8e8e8' },
};

function withLocalStorage(run: () => void): void {
  const values = new Map<string, string>();
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
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

function persistedThemes(): unknown {
  const raw = globalThis.localStorage?.getItem('droid-theme-presets');
  return raw ? JSON.parse(raw) : undefined;
}

// The reducer is pure: persistence happens in the dispatching handler, so
// these transitions never touch storage (persistCustomThemes is tested
// separately below).
test('SAVE_CUSTOM_THEME appends a new preset to state only', () => {
  withLocalStorage(() => {
    const next = reducer(initialState, { type: 'SAVE_CUSTOM_THEME', preset: PRESET });
    assert.deepEqual(next.customThemes, [PRESET]);
    assert.equal(persistedThemes(), undefined);
  });
});

test('SAVE_CUSTOM_THEME upserts an existing preset by id', () => {
  withLocalStorage(() => {
    const state = { ...initialState, customThemes: [PRESET] };
    const renamed = { ...PRESET, name: 'Renamed' };
    const next = reducer(state, { type: 'SAVE_CUSTOM_THEME', preset: renamed });
    assert.deepEqual(next.customThemes, [renamed]);
  });
});

test('DELETE_CUSTOM_THEME removes the preset from state only', () => {
  withLocalStorage(() => {
    const other = { ...PRESET, id: 'custom-two', name: 'Two' };
    const state = { ...initialState, customThemes: [PRESET, other] };
    const next = reducer(state, { type: 'DELETE_CUSTOM_THEME', id: PRESET.id });
    assert.deepEqual(next.customThemes, [other]);
    assert.equal(persistedThemes(), undefined);
  });
});

test('persistCustomThemes writes the list the handler computed', () => {
  withLocalStorage(() => {
    persistCustomThemes([PRESET]);
    assert.deepEqual(persistedThemes(), [PRESET]);
  });
});

// A failed write must reach the handler (throw) instead of being swallowed,
// so the UI can keep state untouched and show a retryable error.
test('persistCustomThemes propagates storage failure instead of faking success', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  } as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: throwing });
  try {
    assert.throws(() => persistCustomThemes([PRESET]));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test('SET_THEME persists presetId with the rest of the theme', () => {
  withLocalStorage(() => {
    const next = reducer(initialState, {
      type: 'SET_THEME',
      theme: { presetId: 'midnight' },
    });
    assert.equal(next.theme.presetId, 'midnight');
    const persisted = JSON.parse(globalThis.localStorage?.getItem('droid-theme') ?? '{}') as {
      presetId?: string;
    };
    assert.equal(persisted.presetId, 'midnight');
  });
});

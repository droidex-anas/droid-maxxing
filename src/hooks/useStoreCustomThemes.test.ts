import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer } from './useStore';
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

test('SAVE_CUSTOM_THEME appends a new preset and persists it', () => {
  withLocalStorage(() => {
    const next = reducer(initialState, { type: 'SAVE_CUSTOM_THEME', preset: PRESET });
    assert.deepEqual(next.customThemes, [PRESET]);
    assert.deepEqual(persistedThemes(), [PRESET]);
  });
});

test('SAVE_CUSTOM_THEME upserts an existing preset by id', () => {
  withLocalStorage(() => {
    const state = { ...initialState, customThemes: [PRESET] };
    const renamed = { ...PRESET, name: 'Renamed' };
    const next = reducer(state, { type: 'SAVE_CUSTOM_THEME', preset: renamed });
    assert.deepEqual(next.customThemes, [renamed]);
    assert.deepEqual(persistedThemes(), [renamed]);
  });
});

test('DELETE_CUSTOM_THEME removes the preset and persists the list', () => {
  withLocalStorage(() => {
    const other = { ...PRESET, id: 'custom-two', name: 'Two' };
    const state = { ...initialState, customThemes: [PRESET, other] };
    const next = reducer(state, { type: 'DELETE_CUSTOM_THEME', id: PRESET.id });
    assert.deepEqual(next.customThemes, [other]);
    assert.deepEqual(persistedThemes(), [other]);
  });
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

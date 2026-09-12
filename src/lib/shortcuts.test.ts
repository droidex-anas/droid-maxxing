import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHORTCUT_DEFINITIONS,
  chordFromEvent,
  conflictingActions,
  defaultShortcutBindings,
  formatChord,
  matchesChord,
  parseChord,
  serializeChord,
} from './shortcuts';

// Node has no Mac user agent, so these exercise the non-Apple branch where the
// primary modifier is Control.

function event(partial: { key: string; code?: string } & Record<string, unknown>) {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: '',
    ...partial,
  } as KeyboardEvent;
}

test('chords round-trip through parse and serialize', () => {
  for (const { defaultChord } of SHORTCUT_DEFINITIONS) {
    const parsed = parseChord(defaultChord);
    assert.ok(parsed, `${defaultChord} must parse`);
    assert.equal(serializeChord(parsed), defaultChord);
  }
  assert.equal(parseChord('Hyper+B'), null);
  assert.equal(
    serializeChord({ meta: true, ctrl: false, alt: true, shift: true, key: 'B' }),
    'Meta+Alt+Shift+B',
  );
});

test('matchesChord reads the physical key, not the character the modifiers produce', () => {
  // Option+\ reports key '«' on a US layout; the binding must still match.
  assert.equal(
    matchesChord(
      event({ ctrlKey: true, altKey: true, key: '«', code: 'Backslash' }),
      'Meta+Alt+\\',
    ),
    true,
  );
  assert.equal(
    matchesChord(event({ ctrlKey: true, key: '\\', code: 'Backslash' }), 'Meta+\\'),
    true,
  );
  assert.equal(
    matchesChord(event({ metaKey: true, key: '\\', code: 'Backslash' }), 'Meta+\\'),
    false,
  );
  assert.equal(
    matchesChord(event({ ctrlKey: true, shiftKey: true, key: 'B', code: 'KeyB' }), 'Meta+B'),
    false,
  );
});

test('chordFromEvent ignores modifier-only presses and stores Ctrl as the primary modifier', () => {
  assert.equal(chordFromEvent(event({ key: 'Control', code: 'ControlLeft' })), null);
  assert.deepEqual(chordFromEvent(event({ ctrlKey: true, key: 'j', code: 'KeyJ' })), {
    meta: true,
    ctrl: false,
    alt: false,
    shift: false,
    key: 'J',
  });
});

test('formatChord collapses the primary and control modifiers off macOS', () => {
  assert.equal(formatChord('Meta+Shift+B'), 'Ctrl+Shift+B');
  assert.equal(formatChord('Meta+Ctrl+B'), 'Ctrl+B');
});

test('defaults are collision-free and conflicts are reported both ways', () => {
  const bindings = defaultShortcutBindings();
  for (const { action } of SHORTCUT_DEFINITIONS) {
    assert.deepEqual(conflictingActions(bindings, action), []);
  }
  const clashing = { ...bindings, openSettings: bindings.toggleSidebar };
  assert.deepEqual(
    conflictingActions(clashing, 'openSettings').map((definition) => definition.action),
    ['toggleSidebar'],
  );
  assert.deepEqual(
    conflictingActions(clashing, 'toggleSidebar').map((definition) => definition.action),
    ['openSettings'],
  );
});

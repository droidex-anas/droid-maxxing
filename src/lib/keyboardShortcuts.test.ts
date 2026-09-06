import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSpecOutlineFindTarget,
  isTerminalInputTarget,
  isTerminalTabShortcut,
  isTranscriptFindNextShortcut,
  isTranscriptFindPreviousShortcut,
  isTranscriptFindShortcut,
  shouldOpenTranscriptFind,
} from './keyboardShortcuts';

const existingAppBindings: Array<{
  ctrlKey: boolean;
  metaKey?: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  key: string;
  name: string;
}> = [
  { ctrlKey: true, shiftKey: false, key: '`', name: 'terminal tab' },
  { ctrlKey: true, shiftKey: false, key: 'k', name: 'command palette' },
  { ctrlKey: true, shiftKey: false, key: 'b', name: 'sidebar' },
  { ctrlKey: true, shiftKey: false, key: '\\', name: 'utility pane' },
  { ctrlKey: true, shiftKey: false, key: ',', name: 'settings' },
  { ctrlKey: true, shiftKey: true, key: 'b', name: 'browser pane' },
  { ctrlKey: true, shiftKey: true, key: 'f', name: 'files pane' },
  { ctrlKey: true, shiftKey: true, key: 'r', name: 'review pane' },
];

function event(
  partial: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    key: string;
  }>,
) {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: '',
    ...partial,
  };
}

test('terminal tab shortcut requires Ctrl+backtick', () => {
  assert.equal(isTerminalTabShortcut({ ctrlKey: true, key: '`' }), true);
  assert.equal(isTerminalTabShortcut({ ctrlKey: false, key: '`' }), false);
  assert.equal(isTerminalTabShortcut({ ctrlKey: true, key: 'r' }), false);
});

test('terminal shortcut targets stay owned by xterm', () => {
  const terminalTarget = {
    closest(selector: string) {
      return selector === '[data-terminal-input]' ? {} : null;
    },
  };
  const appTarget = { closest: () => null };

  assert.equal(isTerminalInputTarget(terminalTarget as unknown as EventTarget), true);
  assert.equal(isTerminalInputTarget(appTarget as unknown as EventTarget), false);
  assert.equal(isTerminalInputTarget(null), false);
});

test('transcript find uses Cmd/Ctrl+F and does not collide with existing app bindings', () => {
  assert.equal(isTranscriptFindShortcut(event({ ctrlKey: true, key: 'f' })), true);
  assert.equal(isTranscriptFindShortcut(event({ metaKey: true, key: 'F' })), true);
  for (const binding of existingAppBindings) {
    assert.equal(
      isTranscriptFindShortcut(event(binding)),
      false,
      `${binding.name} must not open transcript find`,
    );
    assert.equal(
      isTranscriptFindNextShortcut(event(binding)),
      false,
      `${binding.name} must not be find next`,
    );
    assert.equal(
      isTranscriptFindPreviousShortcut(event(binding)),
      false,
      `${binding.name} must not be find previous`,
    );
  }
});

test('find next and previous use unbound G/F3 chords', () => {
  assert.equal(isTranscriptFindNextShortcut(event({ ctrlKey: true, key: 'g' })), true);
  assert.equal(isTranscriptFindNextShortcut(event({ key: 'F3' })), true);
  assert.equal(
    isTranscriptFindPreviousShortcut(event({ ctrlKey: true, shiftKey: true, key: 'g' })),
    true,
  );
  assert.equal(isTranscriptFindPreviousShortcut(event({ shiftKey: true, key: 'F3' })), true);
});

test('transcript find yields to the spec outline and the terminal', () => {
  const outline = {
    closest(selector: string) {
      return selector === '[data-spec-outline]' ? {} : null;
    },
  } as unknown as EventTarget;
  const findEvent = event({ ctrlKey: true, key: 'f' });
  assert.equal(isSpecOutlineFindTarget(outline), true);
  assert.equal(shouldOpenTranscriptFind(findEvent, outline, false), false);
  assert.equal(shouldOpenTranscriptFind(findEvent, null, true), false);
  assert.equal(shouldOpenTranscriptFind(findEvent, null, false), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionPurpose } from './permissionPurpose';
import type { TranscriptEvent } from '../types/bridge';

function event(
  overrides: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'id' | 'kind'>,
): TranscriptEvent {
  return {
    appSessionId: 'sess-a',
    sourceSessionId: 'sess-a',
    role: 'primary',
    ts: 1,
    ...overrides,
  };
}

test('permissionPurpose returns the latest assistant narration', () => {
  const transcript = [
    event({ id: 'user', kind: 'text', author: 'user', text: 'Inspect the project' }),
    event({ id: 'assistant-a', kind: 'text', text: 'I will inspect the repository.' }),
    event({ id: 'tool', kind: 'tool_call', toolName: 'Execute' }),
    event({
      id: 'assistant-b',
      kind: 'text',
      text: 'I need to list the current directory to find the relevant files.',
    }),
  ];

  assert.equal(
    permissionPurpose('exec', transcript),
    'I need to list the current directory to find the relevant files.',
  );
});

test('permissionPurpose prefers current assistant narration and normalizes whitespace', () => {
  const transcript = [
    event({ id: 'user', kind: 'text', author: 'user', text: 'Latest user message' }),
    event({ id: 'assistant', kind: 'text', text: 'I need to\ninspect   the project structure.' }),
  ];

  assert.equal(permissionPurpose('exec', transcript), 'I need to inspect the project structure.');
});

test('permissionPurpose uses the current user request instead of a previous turn', () => {
  const transcript = [
    event({ id: 'assistant', kind: 'text', text: 'I will edit the configuration.' }),
    event({ id: 'user', kind: 'text', author: 'user', text: 'Now list the directory' }),
    event({ id: 'tool', kind: 'tool_call', toolName: 'Execute' }),
  ];

  assert.equal(
    permissionPurpose('exec', transcript),
    'To complete your request: “Now list the directory”',
  );
});

test('permissionPurpose uses an action-specific fallback without narration', () => {
  assert.equal(
    permissionPurpose('edit', []),
    'This file change needs your approval before it can be applied.',
  );
});

test('permissionPurpose truncates long user requests without losing attribution', () => {
  const transcript = [
    event({
      id: 'user',
      kind: 'text',
      author: 'user',
      text: `Inspect ${'the repository '.repeat(20)}`,
    }),
  ];

  const purpose = permissionPurpose('exec', transcript);
  assert.match(purpose, /^To complete your request: “Inspect /);
  assert.match(purpose, /…”$/);
});

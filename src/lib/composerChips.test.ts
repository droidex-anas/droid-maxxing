import assert from 'node:assert/strict';
import test from 'node:test';
import { chipRemovedByBackspace, type ComposerChips } from './composerChips';

const chips = (overrides: Partial<ComposerChips> = {}): ComposerChips => ({
  visualizeSelected: false,
  pastedImageIds: [],
  imagePaths: [],
  skillFilePaths: [],
  documentPaths: [],
  ...overrides,
});

test('backspace removes a skill chip, which the old handler could not reach', () => {
  assert.deepEqual(chipRemovedByBackspace(chips({ skillFilePaths: ['/skills/review/SKILL.md'] })), {
    chip: 'skill',
    filePath: '/skills/review/SKILL.md',
  });
});

test('backspace unwinds the chip row from its right edge', () => {
  const full = chips({
    visualizeSelected: true,
    pastedImageIds: ['img-1'],
    imagePaths: ['/tmp/shot.png'],
    skillFilePaths: ['/skills/review/SKILL.md'],
    documentPaths: ['/repo/notes.md'],
  });
  assert.deepEqual(chipRemovedByBackspace(full), { chip: 'attachment', path: '/repo/notes.md' });
  assert.deepEqual(chipRemovedByBackspace({ ...full, documentPaths: [] }), {
    chip: 'skill',
    filePath: '/skills/review/SKILL.md',
  });
  assert.deepEqual(chipRemovedByBackspace({ ...full, documentPaths: [], skillFilePaths: [] }), {
    chip: 'attachment',
    path: '/tmp/shot.png',
  });
  assert.deepEqual(
    chipRemovedByBackspace({ ...full, documentPaths: [], skillFilePaths: [], imagePaths: [] }),
    { chip: 'pastedImage', id: 'img-1' },
  );
});

test('the Visualize chip goes last and only when it is the only chip left', () => {
  assert.deepEqual(chipRemovedByBackspace(chips({ visualizeSelected: true })), {
    chip: 'visualize',
  });
});

test('the most recent chip of a group goes first', () => {
  assert.deepEqual(chipRemovedByBackspace(chips({ documentPaths: ['/a.md', '/b.md', '/c.md'] })), {
    chip: 'attachment',
    path: '/c.md',
  });
});

test('an empty chip row removes nothing', () => {
  assert.equal(chipRemovedByBackspace(chips()), null);
});

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

test('backspace removes a skill, which the old handler could not reach', () => {
  assert.deepEqual(chipRemovedByBackspace(chips({ skillFilePaths: ['/skills/review/SKILL.md'] })), {
    chip: 'skill',
    filePath: '/skills/review/SKILL.md',
  });
});

// The selections sit on the caret's line and the attachments in a row above it,
// so Backspace empties the line first and then works up through that row.
test('backspace unwinds the selections before the attachment row', () => {
  const full = chips({
    visualizeSelected: true,
    pastedImageIds: ['img-1'],
    imagePaths: ['/tmp/shot.png'],
    skillFilePaths: ['/skills/review/SKILL.md'],
    documentPaths: ['/repo/notes.md'],
  });
  assert.deepEqual(chipRemovedByBackspace(full), {
    chip: 'skill',
    filePath: '/skills/review/SKILL.md',
  });
  const noSkill = { ...full, skillFilePaths: [] };
  assert.deepEqual(chipRemovedByBackspace(noSkill), { chip: 'visualize' });
  const staged = { ...noSkill, visualizeSelected: false };
  assert.deepEqual(chipRemovedByBackspace(staged), { chip: 'attachment', path: '/repo/notes.md' });
  assert.deepEqual(chipRemovedByBackspace({ ...staged, documentPaths: [] }), {
    chip: 'attachment',
    path: '/tmp/shot.png',
  });
  assert.deepEqual(chipRemovedByBackspace({ ...staged, documentPaths: [], imagePaths: [] }), {
    chip: 'pastedImage',
    id: 'img-1',
  });
});

test('Visualize goes off in a single press', () => {
  assert.deepEqual(chipRemovedByBackspace(chips({ visualizeSelected: true })), {
    chip: 'visualize',
  });
});

test('the most recent of a group goes first', () => {
  assert.deepEqual(chipRemovedByBackspace(chips({ documentPaths: ['/a.md', '/b.md', '/c.md'] })), {
    chip: 'attachment',
    path: '/c.md',
  });
});

test('an empty composer removes nothing', () => {
  assert.equal(chipRemovedByBackspace(chips()), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDraftFormat,
  insertBlock,
  insertLink,
  toggleHeading,
  toggleLinePrefix,
  toggleWrap,
} from './composerFormatting';

test('toggleWrap wraps the selection and keeps it selected inside the markers', () => {
  const edit = toggleWrap('fix the bug now', 8, 11, '**');
  assert.deepEqual(edit, {
    text: 'fix the **bug** now',
    selectionStart: 10,
    selectionEnd: 13,
  });
});

test('toggleWrap unwraps a selection that already carries the markers', () => {
  const edit = toggleWrap('fix the **bug** now', 8, 15, '**');
  assert.equal(edit.text, 'fix the bug now');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [8, 11]);
});

test('toggleWrap with an empty selection drops the caret between the markers', () => {
  const edit = toggleWrap('go here', 3, 3, '`');
  assert.equal(edit.text, 'go ``here');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [4, 4]);
});

test('toggleLinePrefix adds the prefix to every selected line', () => {
  const edit = toggleLinePrefix('alpha\nbeta\ngamma', 0, 16, '- ');
  assert.equal(edit.text, '- alpha\n- beta\n- gamma');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [0, 22]);
});

test('toggleLinePrefix removes the prefix once every line carries it', () => {
  const edit = toggleLinePrefix('- alpha\n- beta', 0, 14, '- ');
  assert.equal(edit.text, 'alpha\nbeta');
});

test('toggleLinePrefix only touches the lines the selection overlaps', () => {
  const edit = toggleLinePrefix('alpha\nbeta\ngamma', 6, 10, '- ');
  assert.equal(edit.text, 'alpha\n- beta\ngamma');
});

test('toggleLinePrefix numbers ordered lines sequentially', () => {
  const edit = toggleLinePrefix('alpha\nbeta', 0, 10, '1. ', true);
  assert.equal(edit.text, '1. alpha\n2. beta');
});

test('toggleLinePrefix strips ordered markers of any number', () => {
  const edit = toggleLinePrefix('1. alpha\n22. beta', 0, 16, '1. ', true);
  assert.equal(edit.text, 'alpha\nbeta');
});

test('toggleHeading sets the level on a plain line and keeps the caret in the text', () => {
  const edit = toggleHeading('release notes', 8, 8, 2);
  assert.equal(edit.text, '## release notes');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [11, 11]);
});

test('toggleHeading replaces a different level instead of doubling up', () => {
  const edit = toggleHeading('## release notes', 4, 4, 3);
  assert.equal(edit.text, '### release notes');
});

test('toggleHeading re-applying the same level removes it', () => {
  const edit = toggleHeading('## release notes', 4, 4, 2);
  assert.equal(edit.text, 'release notes');
});

test('insertLink wraps a selection and selects the url placeholder', () => {
  const edit = insertLink('see the docs for more', 8, 12);
  assert.equal(edit.text, 'see the [docs](url) for more');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [15, 18]);
});

test('insertLink with nothing selected offers a label placeholder', () => {
  const edit = insertLink('see ', 4, 4);
  assert.equal(edit.text, 'see [label](url)');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [5, 11]);
});

test('insertBlock separates the snippet from surrounding prose', () => {
  const edit = insertBlock('beforeafter', 6, 6, '| a | b |', 2);
  assert.equal(edit.text, 'before\n| a | b |\nafter');
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [9, 9]);
});

test('insertBlock at the very start needs no leading newline', () => {
  const edit = insertBlock('tail', 0, 0, '| a |', 0);
  assert.equal(edit.text, '| a |\ntail');
});

test('applyDraftFormat routes each toolbar action', () => {
  assert.equal(applyDraftFormat('word', 0, 4, 'bold').text, '**word**');
  assert.equal(applyDraftFormat('word', 0, 4, 'italic').text, '*word*');
  assert.equal(applyDraftFormat('word', 0, 4, 'inlineCode').text, '`word`');
  assert.equal(applyDraftFormat('line', 0, 4, 'heading1').text, '# line');
  assert.equal(applyDraftFormat('line', 0, 4, 'bulletList').text, '- line');
  assert.equal(applyDraftFormat('line', 0, 4, 'taskList').text, '- [ ] line');
  assert.equal(applyDraftFormat('line', 0, 4, 'quote').text, '> line');
  assert.equal(
    applyDraftFormat('', 0, 0, 'table').text,
    '| Header | Header |\n| --- | --- |\n| Cell | Cell |',
  );
  assert.equal(applyDraftFormat('', 0, 0, 'codeBlock').text, '```\n\n```');
});

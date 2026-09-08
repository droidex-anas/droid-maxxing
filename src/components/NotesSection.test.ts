import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotesPanel } from './NotesSection';
import { NotesIntroCard } from './NotesIntroCard';
import type { NoteTag } from '../lib/notesTags';
import type { SessionNote } from '../lib/sessionNotes';

const noop = () => undefined;

// The pad is collapsed by default in the app; tests that exercise its content
// opt into the open state explicitly.
const render = (
  notes: SessionNote[],
  draft = '',
  introVisible = false,
  tag: NoteTag | null = null,
) =>
  renderToStaticMarkup(
    createElement(NotesPanel, {
      notes,
      draft,
      onDraftChange: noop,
      onSave: noop,
      onUse: noop,
      onRemove: noop,
      introVisible,
      onDismissIntro: noop,
      tag,
      onTagSelect: noop,
      onTagClear: noop,
      defaultOpen: true,
    }),
  );

test('the pad starts collapsed so mounting it never reshuffles the panel', () => {
  const html = renderToStaticMarkup(
    createElement(NotesPanel, {
      notes: [note('a', 'Ask about the rollout')],
      draft: '',
      onDraftChange: noop,
      onSave: noop,
      onUse: noop,
      onRemove: noop,
      introVisible: false,
      onDismissIntro: noop,
      tag: null,
      onTagSelect: noop,
      onTagClear: noop,
    }),
  );
  assert.match(html, /aria-expanded="false"/);
  // The header stays informative; the pad and the list mount only on open.
  assert.match(html, /0\/1 sent/);
  assert.doesNotMatch(html, /Write a note to use later/);
  assert.doesNotMatch(html, /Ask about the rollout/);
});

const note = (id: string, text: string, usedAt: number | null = null): SessionNote => ({
  id,
  text,
  createdAt: 1,
  usedAt,
});

test('shows the empty checklist state when no notes are parked', () => {
  const html = render([]);
  assert.match(html, /No notes yet/);
  // The header is a plain panel section label; with no notes there is no
  // checklist fraction trailing it.
  assert.doesNotMatch(html, /sent/);
  // The notepad box carries the save hint in its placeholder, no send button.
  assert.match(html, /Write a note to use later/);
  assert.match(html, /Enter to save/);
  assert.doesNotMatch(html, /Send to composer/);
  // The pad opens three lines tall so it reads as a place to write, then grows.
  assert.match(html, /rows="3"/);
  // The pad uses the field token: raised like the composer on dark, crisp
  // card-surface on light (not elevated, which dims in light mode).
  assert.match(html, /bg-droid-field/);
});

test('stacks saved notes as checklist lines with empty bullets and delete', () => {
  const html = render([note('a', 'Ask about the rollout'), note('b', 'Check migration drift')]);
  assert.match(html, /Ask about the rollout/);
  assert.match(html, /Check migration drift/);
  // One send-to-composer target and one delete button per note.
  assert.equal(html.match(/Send to composer/g)?.length, 2);
  assert.equal(html.match(/Delete note/g)?.length, 2);
  // The header trails the checklist fraction.
  assert.match(html, /0\/2 sent/);
  // Both bullets are empty circles.
  assert.equal(html.match(/border-droid-text-muted\/40/g)?.length, 2);
  assert.doesNotMatch(html, /No notes yet/);
});

test('a note starting with a known @tag shows a chip and stripped text', () => {
  const html = render([note('a', '@bug Login crashes on save')]);
  assert.match(html, />bug</);
  assert.match(html, /bg-droid-red\/15/);
  assert.match(html, /Login crashes on save/);
  // The raw token is not duplicated next to the chip.
  assert.doesNotMatch(html, /@bug/);
  // Untagged notes render their text untouched.
  const plain = render([note('b', 'plain note')]);
  assert.match(plain, /plain note/);
  assert.doesNotMatch(plain, />bug</);
});

test('typing @ in the pad opens the tag menu with every option and hint', () => {
  const html = render([], '@');
  assert.match(html, />bug</);
  assert.match(html, />next</);
  assert.match(html, />idea</);
  assert.match(html, />constraint</);
  assert.match(html, /something broken/);
  // The menu sits in flow directly below the pad: an absolute overlay is
  // clipped by the collapse container's overflow-hidden whenever the note
  // list is shorter than the menu (the empty first-run state).
  assert.ok(html.indexOf('Write a note to use later') < html.indexOf('something broken'));
  assert.doesNotMatch(html, /top-full/);
  // Pills are fully rounded to match the app's geometry.
  assert.match(html, /rounded-full/);
});

test('the tag menu narrows as the @query grows', () => {
  const html = render([], '@n');
  assert.match(html, />next</);
  assert.doesNotMatch(html, />idea</);
  assert.doesNotMatch(html, />bug</);
});

test('a selected tag chips inside the pad and swaps the placeholder', () => {
  const html = render([], '', false, 'bug');
  assert.match(html, />bug</);
  assert.match(html, /aria-label="Remove tag"/);
  assert.match(html, /Add the detail/);
  // A chipped tag keeps the @ menu closed even with an empty draft.
  assert.doesNotMatch(html, /something broken/);
});

test('a note sent to the composer gets a filled bullet and counts in the header', () => {
  const html = render([
    note('a', 'Ask about the rollout', 123),
    note('b', 'Check migration drift'),
  ]);
  assert.match(html, /1\/2 sent/);
  // Exactly one filled bullet, one empty one.
  assert.equal(html.match(/bg-droid-accent/g)?.length, 1);
  assert.equal(html.match(/border-droid-text-muted\/40/g)?.length, 1);
});

const renderIntro = () =>
  renderToStaticMarkup(
    createElement(NotesIntroCard, {
      style: { position: 'fixed', top: 0, left: 0 },
      caretTop: 40,
      onTry: noop,
      onClose: noop,
    }),
  );

test('the floating intro announces the feature with a try and dismiss action', () => {
  const html = renderIntro();
  assert.match(html, /Meet Notes/);
  assert.match(html, /Write reminders in the pad below/);
  assert.match(html, /Try it now/);
  assert.match(html, /aria-label="Dismiss"/);
  // A caret points back at the Notes card.
  assert.match(html, /rotate-45/);
  // The accent is white in this theme, so the CTA must use dark text.
  assert.match(html, /text-droid-bg/);
  assert.doesNotMatch(html, /text-white/);
});

test('the intro floats through a portal, so static markup stays anchor-only', () => {
  assert.doesNotMatch(render([], '', true), /Meet Notes/);
  assert.doesNotMatch(render([], ''), /Meet Notes/);
});

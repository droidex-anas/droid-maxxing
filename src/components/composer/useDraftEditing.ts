// Draft edits that arrive from outside the keyboard: the right-click menu and
// the formatting shortcuts. Each one replaces text and then wants a particular
// selection — the wrapped word, a url placeholder, the caret after a paste. The
// editor receives the new text through its `value` prop, so the selection is
// restored once that text has landed rather than when the action runs.

import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { applyDraftFormat, type DraftFormatAction } from '../../lib/composerFormatting';
import type { ComposerHandle } from './ComposerEditor';
import type { DraftEditAction, SelectionMenuState } from './SelectionMenu';

interface Range {
  start: number;
  end: number;
}

export function useDraftEditing({
  input,
  editDraft,
  editorRef,
}: {
  input: string;
  // Replaces the draft the way typing does, leaving history-recall mode.
  editDraft: (text: string) => void;
  editorRef: RefObject<ComposerHandle | null>;
}) {
  const [menu, setMenu] = useState<SelectionMenuState | null>(null);
  const pendingRange = useRef<Range | null>(null);
  // The clipboard resolves later; a paste must splice into the draft as it is
  // then, not as it was when the menu was clicked.
  const latestInput = useRef(input);
  latestInput.current = input;

  useEffect(() => {
    const range = pendingRange.current;
    const editor = editorRef.current;
    if (!range || !editor) return;
    pendingRange.current = null;
    editor.focus();
    editor.select(range.start, range.end);
  }, [input, editorRef]);

  const selection = (): Range =>
    editorRef.current?.selection() ?? { start: input.length, end: input.length };

  const replace = (text: string, range: Range) => {
    editDraft(text);
    pendingRange.current = range;
  };

  // Selection-scoped actions (bold, link) hit what is selected; with nothing
  // selected the line-scoped ones (headings, lists, quotes) hit the caret's line.
  const applyFormat = (action: DraftFormatAction) => {
    const { start, end } = selection();
    const edit = applyDraftFormat(input, start, end, action);
    replace(edit.text, { start: edit.selectionStart, end: edit.selectionEnd });
  };

  // Cut, copy, paste and select-all. The platform menu is cancelled in favour
  // of the composer's own, so the draft has to carry these itself.
  const applyEdit = (action: DraftEditAction) => {
    const editor = editorRef.current;
    const { start, end } = selection();
    if (action === 'selectAll') {
      editor?.focus();
      editor?.select(0, input.length);
      return;
    }
    const selected = input.slice(start, end);
    if (action === 'copy' || action === 'cut') {
      if (selected === '') return;
      // A cut only removes text once the clipboard has it.
      navigator.clipboard.writeText(selected).then(
        () => {
          if (action === 'cut')
            replace(input.slice(0, start) + input.slice(end), { start, end: start });
        },
        (error: unknown) => {
          console.warn('Clipboard write failed', error);
        },
      );
      return;
    }
    navigator.clipboard.readText().then(
      (text) => {
        if (text === '' || latestInput.current !== input) return;
        const caret = start + text.length;
        replace(input.slice(0, start) + text + input.slice(end), { start: caret, end: caret });
      },
      (error: unknown) => {
        console.warn('Clipboard read failed', error);
      },
    );
  };

  // Right-clicking anywhere in the draft opens the menu; its actions are line-
  // or selection-scoped, so it never needs a selection to be useful.
  const openMenu = (event: MouseEvent) => {
    // A rendered table's cells are their own editable fields; the platform
    // menu already serves them, and the draft actions would not.
    if (event.target instanceof HTMLElement && event.target.closest('.cm-md-tableframe')) return;
    event.preventDefault();
    const { start, end } = selection();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      hasSelection: end > start,
      link: editorRef.current?.linkAt(event.clientX, event.clientY) ?? null,
    });
  };

  // Stable, so the menu's window listeners are bound once per opening.
  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  return { menu, openMenu, closeMenu, applyFormat, applyEdit };
}

// The composer's editing surface: a CodeMirror view that renders markdown live
// (see liveMarkdown.ts) and reports its text and caret upward, so the composer
// state in PromptInput stays the single owner of the draft. Text flows down
// only as external edits — seeds, history recall, formatting actions — and the
// editor is the only writer while the user types.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, placeholder as cmPlaceholder } from '@codemirror/view';
import { liveMarkdown, linkHrefAt } from './liveMarkdown';
import { diffEdit } from './composerEditorSync';
import { noteComposerInteractive } from '../../lib/rendererPerf';

export interface ComposerHandle {
  focus(): void;
  select(start: number, end?: number): void;
  selection(): { start: number; end: number };
  // The address of the link under a screen point, so a right-click on a link in
  // the draft can offer to open or copy it.
  linkAt(x: number, y: number): string | null;
}

interface ComposerEditorProps {
  value: string;
  placeholder: string;
  // Width of the skill/plugin chips sharing the draft's first line.
  indentPx: number;
  ariaLabel: string;
  onChange: (text: string) => void;
  onCaret: (caret: number) => void;
  // Capture-phase keydown from inside the editor: the composer decides (and
  // prevents) Enter-to-send, menu navigation, and formatting shortcuts before
  // the editor's own keymap sees them.
  onKeyDown: (event: KeyboardEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onPasteFiles: (files: File[]) => void;
  // The editor loads lazily; edits queued before it exists apply on this.
  onReady: () => void;
}

const ComposerEditor = forwardRef<ComposerHandle, ComposerEditorProps>(function ComposerEditor(
  {
    value,
    placeholder,
    indentPx,
    ariaLabel,
    onChange,
    onCaret,
    onKeyDown,
    onContextMenu,
    onPasteFiles,
    onReady,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const placeholderCompartment = useRef(new Compartment());
  // External syncs dispatch with this flag up so the update listener reports
  // them as value changes, not as user typing (which would reset history
  // recall mode in the composer).
  const applyingExternal = useRef(false);
  const propsRef = useRef({ onChange, onCaret, onKeyDown, onPasteFiles, onReady });
  propsRef.current = { onChange, onCaret, onKeyDown, onPasteFiles, onReady };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    noteComposerInteractive();
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          liveMarkdown(),
          EditorView.lineWrapping,
          placeholderCompartment.current.of(cmPlaceholder(placeholder)),
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            'aria-multiline': 'true',
            spellcheck: 'true',
            autocorrect: 'off',
            autocapitalize: 'off',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternal.current) {
              propsRef.current.onChange(update.state.doc.toString());
            }
            applyingExternal.current = false;
            if (update.docChanged || update.selectionSet) {
              propsRef.current.onCaret(update.state.selection.main.head);
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    // The composer's keydown handling runs before the editor's: capture on the
    // host sees events headed for the content element first, and stopping
    // propagation keeps the editor keymap out of keys it must not interpret.
    const onHostKeyDown = (event: KeyboardEvent) => {
      propsRef.current.onKeyDown(event);
    };
    const onHostPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      propsRef.current.onPasteFiles(files);
    };
    host.addEventListener('keydown', onHostKeyDown, true);
    host.addEventListener('paste', onHostPaste, true);
    propsRef.current.onReady();
    return () => {
      host.removeEventListener('keydown', onHostKeyDown, true);
      host.removeEventListener('paste', onHostPaste, true);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(cmPlaceholder(placeholder)),
    });
  }, [placeholder]);

  // External text (seeds, history recall, formatting) edits the document.
  // Typing never comes through here: the editor already holds that text.
  // Only the changed span is dispatched, so the caret keeps its place instead
  // of being thrown to the end of the draft.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const edit = diffEdit(view.state.doc.toString(), value);
    if (!edit) return;
    applyingExternal.current = true;
    view.dispatch({ changes: edit, scrollIntoView: true });
  }, [value]);

  // Chips over the first line indent the whole draft block; the theme adds
  // this to the content padding it owns.
  useEffect(() => {
    hostRef.current?.style.setProperty('--composer-indent', `${String(indentPx)}px`);
  }, [indentPx]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      select: (start: number, end?: number) => {
        const view = viewRef.current;
        if (!view) return;
        const doc = view.state.doc;
        const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.length));
        const anchor = clamp(start);
        const head = end === undefined ? anchor : clamp(end);
        view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      },
      selection: () => {
        const selection = viewRef.current?.state.selection.main;
        return selection ? { start: selection.from, end: selection.to } : { start: 0, end: 0 };
      },
      linkAt: (x: number, y: number) => {
        const view = viewRef.current;
        const pos = view?.posAtCoords({ x, y });
        return view && pos != null ? linkHrefAt(view, pos) : null;
      },
    }),
    [],
  );

  return (
    <div ref={hostRef} className="w-full text-sm text-droid-text" onContextMenu={onContextMenu} />
  );
});

export default ComposerEditor;

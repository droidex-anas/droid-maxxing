// Live markdown for the prompt composer: the markdown parser drives decorations
// that style syntax as it is typed and fold the markers rendered markdown would
// not show, while bare URLs and link labels become clickable. The document stays
// plain markdown text, so what is sent is exactly what is typed.

import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap, insertNewline } from '@codemirror/commands';
import { StateField } from '@codemirror/state';
import {
  buildMarkdownDecorations,
  caretOf,
  type MarkdownDecorations,
} from './liveMarkdownDecorations';
import { liveMarkdownTheme } from './liveMarkdownTheme';

// `##text` is not a heading in markdown — the space is required — so typing it
// used to leave the hashes sitting there as literal text while `## text` folded
// them away. Typing the first character of the title inserts that space, so a
// heading starts the moment it is recognisable and the document stays valid
// markdown. A single `#` is left alone: `#1` and `#release` are ordinary words.
export function needsHeadingSpace(beforeCaret: string, typed: string): boolean {
  if (typed.length !== 1 || typed === ' ' || typed === '#') return false;
  // Up to three spaces of indentation still make a heading in CommonMark.
  return /^ {0,3}#{2,6}$/.test(beforeCaret);
}

function insideCode(view: EditorView, pos: number): boolean {
  let node: LinkNode | null = syntaxTree(view.state).resolveInner(pos, -1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
      return true;
    }
    node = node.parent;
  }
  return false;
}

const headingAutoSpace = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to) return false;
  const line = view.state.doc.lineAt(from);
  if (!needsHeadingSpace(line.text.slice(0, from - line.from), text)) return false;
  // Code is typed verbatim; `##x` inside a fence is the writer's own text.
  if (insideCode(view, from)) return false;
  view.dispatch({
    changes: { from, insert: ` ${text}` },
    selection: { anchor: from + 2 },
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return true;
});

// Decorations live in a state field rather than a view plugin because a table
// is drawn as a block widget, and CodeMirror only accepts block decorations
// from state. It rebuilds when the document, the caret, or the parse changes:
// the caret decides which markers fold, and the parser can finish a long paste
// after the transaction that inserted it, which would otherwise leave the tail
// of the draft unstyled until the next keystroke.
const markdownDecorations = StateField.define<MarkdownDecorations>({
  create: (state) => buildMarkdownDecorations(state),
  update(current, transaction) {
    const caretMoved = caretOf(transaction.startState) !== caretOf(transaction.state);
    const reparsed = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    if (!transaction.docChanged && !caretMoved && !reparsed) return current;
    return buildMarkdownDecorations(transaction.state);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.all),
    // Only folded markers are atomic: arrow keys step over them instead of
    // through invisible characters, and Backspace at a boundary removes the
    // marker whole. Styling spans are deliberately excluded — making those
    // atomic would stop the caret entering a bold, code or link span at all.
    // The table widget is excluded too, so the caret can move in and edit it.
    EditorView.atomicRanges.of((view) => view.state.field(field).hidden),
  ],
});

// The structural slice of a lezer SyntaxNode the tree walks here need.
interface LinkNode {
  name: string;
  from: number;
  to: number;
  parent: LinkNode | null;
  getChild(type: string): LinkNode | null;
}

// The href a click at `pos` would open: inside a bare URL, or inside the label
// of a [label](destination) link whose destination is a real URL.
export function linkHrefAt(view: EditorView, pos: number): string | null {
  let node: LinkNode | null = syntaxTree(view.state).resolveInner(pos, 1);
  while (node) {
    if (node.name === 'InlineCode' || node.name === 'FencedCode') return null;
    if (node.name === 'URL') return docHref(view, node.from, node.to);
    if (node.name === 'Link') {
      const url = node.getChild('URL');
      if (url) return docHref(view, url.from, url.to);
    }
    node = node.parent;
  }
  return null;
}

function docHref(view: EditorView, from: number, to: number): string | null {
  const text = view.state.doc.sliceString(from, to);
  if (/^www\./i.test(text)) return `https://${text}`;
  return /^https?:\/\//i.test(text) || /^mailto:/i.test(text) ? text : null;
}

// A click opens a link; a drag that selects across one does not. mousedown only
// remembers the candidate, and mouseup decides once the gesture is settled.
function linkInteraction() {
  let pending: { x: number; y: number; href: string } | null = null;
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      pending = null;
      const plainClick =
        event.button === 0 &&
        event.detail === 1 &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey;
      if (!plainClick) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return;
      const href = linkHrefAt(view, pos);
      if (href === null) return;
      pending = { x: event.clientX, y: event.clientY, href };
    },
    mouseup(event, view) {
      const candidate = pending;
      pending = null;
      if (!candidate) return;
      if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 4) return;
      if (!view.state.selection.main.empty) return;
      event.preventDefault();
      window.open(candidate.href, '_blank', 'noopener,noreferrer');
    },
  });
}

// `insertNewlineContinueMarkup` only acts inside list and quote markup — on a
// heading or an ordinary line it declines — so an unconditional newline has to
// back it up, or the key does nothing at all.
function breakLine(view: EditorView): boolean {
  return insertNewlineContinueMarkup(view) || insertNewline(view);
}

// One editor package for the composer: GFM parsing, live decorations, link
// clicks, undo, and the newline bindings. Plain Enter never reaches here — the
// composer intercepts it to send — so Shift+Enter and Alt+Enter are the ways to
// break a line, both continuing the list or quote the caret sits in. Backspace
// unwinds that markup (bound by `markdown()` itself), which is how a folded
// `### ` marker is removed.
export function liveMarkdown() {
  return [
    // `markdownLanguage` rather than the default commonmark base: it already
    // carries the GFM extensions this composer parses.
    markdown({ base: markdownLanguage }),
    headingAutoSpace,
    markdownDecorations,
    linkInteraction(),
    liveMarkdownTheme,
    history(),
    keymap.of([
      ...historyKeymap,
      { key: 'Shift-Enter', run: breakLine },
      { key: 'Alt-Enter', run: breakLine },
    ]),
  ];
}

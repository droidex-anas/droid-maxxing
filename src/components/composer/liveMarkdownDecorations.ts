// Decorations for the composer's live markdown: the parsed syntax tree drives
// text styling, and the markers that rendered markdown would not show are
// replaced with nothing so the draft reads as the message it will become.
//
// Two sets come out of one pass. `all` styles the document; `hidden` holds only
// the replaced ranges and is what makes caret motion skip folded markers. They
// must stay separate: styling spans cover whole words, and treating those as
// atomic would stop the caret from ever entering a bold or code span.

import { syntaxTree } from '@codemirror/language';
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { EditorState, Range, Text } from '@codemirror/state';
import { TableWidget, parseTableRows } from './liveMarkdownTable';

export interface MarkdownDecorations {
  all: DecorationSet;
  hidden: DecorationSet;
}

// A rule folds into a line only once the caret leaves it. While the caret is on
// the line the dashes stay text, so typing `---` (or a table's separator row)
// never makes characters jump out from under the cursor.
class Rule extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const line = document.createElement('span');
    line.className = 'cm-md-hr';
    return line;
  }
}

// A link destination only folds once it looks like a real URL: the `url`
// placeholder that the formatting menu selects must stay visible to type over.
function destinationIsUrl(text: string): boolean {
  return /^(https?:\/\/|www\.|mailto:|#|\/)/i.test(text);
}

function forEachLine(doc: Text, from: number, to: number, at: (lineFrom: number) => void) {
  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);
    at(line.from);
    pos = line.to + 1;
  }
}

// The structural slice of a lezer SyntaxNode these decorations need.
interface SyntaxNodeLike {
  from: number;
  to: number;
  name: string;
  parent: SyntaxNodeLike | null;
  getChild(type: string): SyntaxNodeLike | null;
  prevSibling: SyntaxNodeLike | null;
  nextSibling: SyntaxNodeLike | null;
}

// Collects the two sets so a decoration is registered as atomic exactly when it
// replaces text, without the caller having to remember which kind it pushed.
class DecorationBuilder {
  readonly styled: Range<Decoration>[] = [];
  readonly folded: Range<Decoration>[] = [];

  constructor(
    readonly doc: Text,
    readonly caret: number,
  ) {}

  private onCaretLine(pos: number): boolean {
    return this.doc.lineAt(pos).number === this.doc.lineAt(this.caret).number;
  }

  mark(from: number, to: number, className: string) {
    if (to <= from) return;
    this.styled.push(Decoration.mark({ class: className }).range(from, to));
  }

  line(at: number, className: string) {
    this.styled.push(Decoration.line({ class: className }).range(this.doc.lineAt(at).from));
  }

  fold(from: number, to: number, decoration = Decoration.replace({})) {
    if (to <= from) return;
    this.folded.push(decoration.range(from, to));
  }

  // A block drawn in place of its source — a table. Deliberately not atomic:
  // the caret has to be able to move into the block, because arriving there is
  // what puts the markdown source back so it can be edited.
  foldBlock(from: number, to: number, widget: Decoration) {
    if (to <= from) return;
    this.styled.push(widget.range(from, to));
  }

  // `###` and `>` put a line into a mode, so they stay legible — dimmed, but
  // present — while the caret is touching them: the writer watches the marker
  // as they type it, and can come back to delete it to get ordinary text again.
  // It folds as soon as the caret moves past it into the content, which is the
  // moment the styled line itself says what the marker did.
  //
  // The trailing space belongs to the marker, so content sits at the margin
  // once it folds.
  foldBlockMarker(from: number, to: number) {
    const space = this.doc.sliceString(to, to + 1) === ' ' ? 1 : 0;
    if (this.caret >= from && this.caret <= to + space) {
      this.mark(from, to, 'cm-md-marker');
      return;
    }
    this.fold(from, to + space);
  }

  // A table spans whole lines, so the widget replacing it has to as well.
  // Returns whether the walk should descend into the table's children: once the
  // block is replaced its inner marks would land inside replaced text.
  table(from: number, to: number): boolean {
    const start = this.doc.lineAt(from).from;
    const end = this.doc.lineAt(to).to;
    const rows =
      this.caret >= start && this.caret <= end
        ? null
        : parseTableRows(this.doc.sliceString(start, end));
    if (!rows) {
      for (let pos = start; pos <= end; ) {
        const line = this.doc.lineAt(pos);
        this.line(line.from, 'cm-md-table');
        pos = line.to + 1;
      }
      return true;
    }
    this.foldBlock(
      start,
      end,
      Decoration.replace({
        widget: new TableWidget(rows, this.doc.sliceString(start, end), start, end),
        block: true,
      }),
    );
    return false;
  }

  // A rule is the whole line, so folding it while the caret sits there would
  // pull the dashes out from under the cursor.
  foldRule(from: number, to: number) {
    if (this.onCaretLine(from)) return;
    this.fold(from, to, Decoration.replace({ widget: new Rule() }));
  }

  build(): MarkdownDecorations {
    return {
      all: Decoration.set([...this.styled, ...this.folded], true),
      hidden: Decoration.set([...this.folded], true),
    };
  }
}

// A [label](destination) link: the label is styled and clickable, the brackets
// fold, and the destination folds once it is a real URL.
function decorateLink(builder: DecorationBuilder, syntax: SyntaxNodeLike) {
  const url = syntax.getChild('URL');
  if (url === null) return;
  const open = url.prevSibling; // the `](` before the destination
  if (open?.name !== 'LinkMark') return;
  if (url.nextSibling?.to !== syntax.to) return;
  builder.fold(syntax.from, syntax.from + 1); // leading [
  builder.mark(syntax.from + 1, open.from, 'cm-md-link');
  if (destinationIsUrl(builder.doc.sliceString(url.from, url.to))) {
    builder.fold(open.from - 1, syntax.to); // ](url)
  }
}

// Which markers are folded depends on where the caret is, so a selection change
// can change the decorations and the view plugin watches this value.
export function caretOf(state: EditorState): number {
  return state.selection.main.head;
}

export function buildMarkdownDecorations(state: EditorState): MarkdownDecorations {
  const doc = state.doc;
  const builder = new DecorationBuilder(doc, caretOf(state));

  syntaxTree(state).iterate({
    enter(node) {
      const syntax: SyntaxNodeLike = node.node;
      const heading = /^ATXHeading([1-6])$/.exec(syntax.name);
      if (heading) {
        builder.line(syntax.from, `cm-md-h${heading[1]}`);
        return;
      }
      switch (syntax.name) {
        // The marker line of a setext heading stays visible; only its text is
        // styled, so the user can still see what makes it a heading.
        case 'SetextHeading1':
          builder.line(syntax.from, 'cm-md-h1');
          return;
        case 'SetextHeading2':
          builder.line(syntax.from, 'cm-md-h2');
          return;
        case 'HeaderMark':
          if (syntax.parent?.name.startsWith('ATXHeading')) {
            builder.foldBlockMarker(syntax.from, syntax.to);
          }
          return;
        case 'StrongEmphasis':
          builder.mark(syntax.from, syntax.to, 'cm-md-strong');
          return;
        case 'Emphasis':
          builder.mark(syntax.from, syntax.to, 'cm-md-em');
          return;
        case 'Strikethrough':
          builder.mark(syntax.from, syntax.to, 'cm-md-strike');
          return;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          builder.fold(syntax.from, syntax.to);
          return;
        case 'InlineCode':
          builder.mark(syntax.from, syntax.to, 'cm-md-code');
          return;
        // The `` ` `` fences of inline code fold; the ``` fences of a block stay
        // visible but muted, so block boundaries remain obvious.
        case 'CodeMark':
          if (syntax.parent?.name === 'InlineCode') {
            builder.fold(syntax.from, syntax.to);
          } else {
            builder.mark(syntax.from, syntax.to, 'cm-md-fence');
          }
          return;
        case 'CodeInfo':
          builder.mark(syntax.from, syntax.to, 'cm-md-fence');
          return;
        case 'FencedCode':
          forEachLine(doc, syntax.from, syntax.to, (at) => {
            builder.line(at, 'cm-md-codeline');
          });
          return;
        case 'Blockquote':
          forEachLine(doc, syntax.from, syntax.to, (at) => {
            builder.line(at, 'cm-md-quote');
          });
          return;
        case 'QuoteMark':
          builder.foldBlockMarker(syntax.from, syntax.to);
          return;
        case 'ListMark':
          builder.mark(syntax.from, syntax.to, 'cm-md-listmark');
          return;
        // `[x]` and `[ ]` stay the characters the writer typed — swapping them
        // for a checkbox widget would move the caret around — but a ticked box
        // is coloured so a task list can be read at a glance while drafting.
        case 'TaskMarker':
          builder.mark(
            syntax.from,
            syntax.to,
            doc.sliceString(syntax.from, syntax.to).includes('x')
              ? 'cm-md-task-done'
              : 'cm-md-task',
          );
          return;
        case 'Link':
          decorateLink(builder, syntax);
          return;
        // Bare URLs autolinked by the GFM extension.
        case 'URL':
          if (syntax.parent?.name !== 'Link') {
            builder.mark(syntax.from, syntax.to, 'cm-md-url');
          }
          return;
        // Away from the caret a table is drawn as a table; inside it the source
        // comes back, monospaced so the pipes line up column by column while
        // they are being typed.
        case 'Table':
          return builder.table(syntax.from, syntax.to);
        case 'TableHeader':
          builder.mark(syntax.from, syntax.to, 'cm-md-tablehead');
          return;
        case 'HorizontalRule':
          builder.foldRule(syntax.from, syntax.to);
          return;
        default:
          return;
      }
    },
  });

  return builder.build();
}

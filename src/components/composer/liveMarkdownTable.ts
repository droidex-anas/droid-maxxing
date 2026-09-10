// A GFM table in the draft, drawn as a real table and edited as one.
//
// The pipes are only readable while you are lining them up; after that they are
// noise, and a draft that will arrive as a table should look like one. Cells are
// editable in place and write straight back into the markdown, so the document
// stays plain text that is sent exactly as typed. The source is still reachable
// — arrow into the block, or click the frame outside a cell — for the edits a
// grid cannot express, such as adding a row or changing alignment.

import { WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';

export interface TableRows {
  header: string[];
  // Kept verbatim so column alignment (`:--`, `--:`) survives a cell edit.
  delimiter: string;
  body: string[][];
}

// `|` inside a cell is written `\|`; splitting has to respect that, and the
// escape is dropped once the cell is its own value.
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// The `| --- | :-- |` line that separates a header from its body, and marks the
// block as a table in the first place.
function isDelimiterRow(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(line);
}

export function parseTableRows(source: string): TableRows | null {
  const lines = source.split('\n').filter((line) => line.trim() !== '');
  const delimiter = lines.findIndex(isDelimiterRow);
  if (delimiter < 1) return null;
  return {
    header: splitRow(lines[delimiter - 1]),
    delimiter: lines[delimiter].trim(),
    body: lines.slice(delimiter + 1).map(splitRow),
  };
}

// A cell's own text can contain the character that separates cells, and a
// newline would split the row in two, so both are neutralised on the way out.
function escapeCell(cell: string): string {
  return cell
    .replace(/\s+/g, ' ')
    .replace(/\|/g, String.raw`\|`)
    .trim();
}

export function toTableMarkdown(rows: TableRows): string {
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [line(rows.header), rows.delimiter, ...rows.body.map(line)].join('\n');
}

// Where each drawn table currently sits in the document. Editing a cell rewrites
// that span, and the span moves as the draft above it changes, so it is kept on
// the DOM node rather than captured by the listeners — which would go stale the
// moment the widget was replaced.
const widgetSpans = new WeakMap<HTMLElement, { from: number; to: number }>();

function readCells(frame: HTMLElement): string[][] {
  return [...frame.querySelectorAll('tr')].map((row) =>
    [...row.children].map((cell) => cell.textContent),
  );
}

function rowsFromDom(frame: HTMLElement, delimiter: string): TableRows | null {
  const rows = readCells(frame);
  if (rows.length === 0) return null;
  return { header: rows[0], delimiter, body: rows.slice(1) };
}

export class TableWidget extends WidgetType {
  constructor(
    readonly rows: TableRows,
    readonly source: string,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  // Position is part of identity. A table that only moved — text typed above it
  // — has to pass through updateDOM, which is where its span is refreshed.
  // Matching on source alone let CodeMirror keep the node with a stale span, so
  // the next cell edit rewrote whatever text now sat at the old offsets.
  eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from;
  }

  // Cell edits have already changed this DOM — rebuilding it would drop the
  // caret mid-word — so the node is kept and only its span is refreshed. A
  // change from anywhere else does not match what the DOM shows, and there
  // CodeMirror is left to build the widget again.
  updateDOM(dom: HTMLElement) {
    const current = rowsFromDom(dom, this.rows.delimiter);
    if (!current || toTableMarkdown(current) !== this.source) return false;
    widgetSpans.set(dom, { from: this.from, to: this.to });
    return true;
  }

  private writeBack(frame: HTMLElement, view: EditorView) {
    const span = widgetSpans.get(frame);
    const rows = rowsFromDom(frame, this.rows.delimiter);
    if (!span || !rows) return;
    const markdown = toTableMarkdown(rows);
    if (markdown === view.state.doc.sliceString(span.from, span.to)) return;

    // CodeMirror re-points the DOM selection at its own state after an update.
    // The caret is inside a cell, which that state knows nothing about, so it
    // would land at the end of the cell — typing into the middle of a word
    // would scatter the letters to the end. The place in the text is taken
    // before the update and put back after it.
    const selection = window.getSelection();
    const caretNode = selection?.anchorNode ?? null;
    const caretOffset = selection?.anchorOffset ?? 0;

    view.dispatch({ changes: { from: span.from, to: span.to, insert: markdown } });

    if (!selection || !caretNode || !frame.contains(caretNode)) return;
    const range = document.createRange();
    const limit = caretNode.textContent?.length ?? caretOffset;
    range.setStart(caretNode, Math.min(caretOffset, limit));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  toDOM(view: EditorView) {
    const frame = document.createElement('div');
    frame.className = 'cm-md-tableframe scrollbar-on-hover';
    frame.contentEditable = 'false';
    widgetSpans.set(frame, { from: this.from, to: this.to });

    const table = document.createElement('table');
    const fill = (cell: HTMLElement, text: string) => {
      cell.textContent = text;
      cell.contentEditable = 'true';
      cell.spellcheck = false;
      return cell;
    };

    const head = table.createTHead().insertRow();
    for (const text of this.rows.header) {
      head.appendChild(fill(document.createElement('th'), text));
    }
    const body = table.createTBody();
    for (const row of this.rows.body) {
      const tr = body.insertRow();
      // A short row still has to fill the header's columns, or the frame's
      // borders stop lining up below it.
      for (let column = 0; column < this.rows.header.length; column += 1) {
        fill(tr.insertCell(), row[column] ?? '');
      }
    }
    frame.appendChild(table);

    frame.addEventListener('input', () => {
      this.writeBack(frame, view);
    });
    // A cell is one line. Enter would split the row, and a rich paste would
    // bring markup into text that has to survive as markdown.
    frame.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    // Paste lands as plain text on one line: markup pasted into a cell would
    // not survive the trip back out to markdown, and a newline would split the
    // row. Inserting it by hand means no input event fires, so the write-back
    // is called directly.
    frame.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\s+/g, ' ');
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || text === '') return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const inserted = document.createTextNode(text);
      range.insertNode(inserted);
      range.setStartAfter(inserted);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      this.writeBack(frame, view);
    });
    // Clicking the frame itself rather than a cell is the way back to the
    // markdown, for the edits a grid cannot express.
    frame.addEventListener('mousedown', (event) => {
      if (event.target !== frame) return;
      event.preventDefault();
      const span = widgetSpans.get(frame);
      view.dispatch({ selection: { anchor: span?.from ?? this.from }, scrollIntoView: true });
      view.focus();
    });
    return frame;
  }
}

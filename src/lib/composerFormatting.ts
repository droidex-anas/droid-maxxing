// Pure draft transformations behind the composer's markdown toolbar and
// shortcuts. Everything returns the edited text plus where the selection
// lands, so the caller applies both to the textarea in one pass.

export interface DraftEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export type DraftFormatAction =
  | 'bold'
  | 'italic'
  | 'inlineCode'
  | 'link'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'taskList'
  | 'quote'
  | 'table'
  | 'codeBlock';

// Wraps or unwraps an inline marker such as **, *, or ` around the selection.
// An empty selection inserts the markers and leaves the caret between them.
export function toggleWrap(text: string, start: number, end: number, marker: string): DraftEdit {
  const selected = text.slice(start, end);
  if (
    selected.length >= marker.length * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  return {
    text: text.slice(0, start) + marker + selected + marker + text.slice(end),
    selectionStart: start + marker.length,
    selectionEnd: end + marker.length,
  };
}

function lineBounds(text: string, start: number, end: number): { start: number; end: number } {
  const nextBreak = text.indexOf('\n', end);
  return {
    start: text.lastIndexOf('\n', Math.max(0, start - 1)) + 1,
    end: nextBreak === -1 ? text.length : nextBreak,
  };
}

// Toggles a line prefix ('- ', '> ', '- [ ] ') over every selected line: add it
// to all when any line lacks it, strip it from all when every line has it.
// '1. ' numbers the lines instead of repeating a literal one.
export function toggleLinePrefix(
  text: string,
  start: number,
  end: number,
  prefix: string,
  numbered = false,
): DraftEdit {
  const bounds = lineBounds(text, start, end);
  const lines = text.slice(bounds.start, bounds.end).split('\n');
  const strip = numbered ? /^\d+\.\s/ : new RegExp(`^${escapeRegExp(prefix)}`);
  const hasPrefix = (line: string) => strip.test(line);
  // Blank lines inside a selection are left alone, but a selection that is
  // nothing but blank lines (an empty draft) gets the prefix so the action
  // starts the list or quote the writer asked for.
  const allBlank = lines.every((line) => line === '');
  const removing = !allBlank && lines.every((line) => hasPrefix(line) || line === '');
  const nextLines = lines.map((line, index) => {
    if (line === '' && !allBlank) return line;
    if (removing) return line.replace(strip, '');
    if (hasPrefix(line)) return line;
    return numbered ? `${String(index + 1)}. ${line}` : `${prefix}${line}`;
  });
  const block = nextLines.join('\n');
  return {
    text: text.slice(0, bounds.start) + block + text.slice(bounds.end),
    selectionStart: bounds.start,
    selectionEnd: bounds.start + block.length,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Applies one heading level to the line the selection starts on. Re-applying
// the level the line already carries removes the heading.
export function toggleHeading(text: string, start: number, end: number, level: number): DraftEdit {
  const bounds = lineBounds(text, start, start);
  const line = text.slice(bounds.start, bounds.end);
  // A heading needs a space after its hashes: `#release` is a word.
  const existing = /^(#{1,6})(?: |$)/.exec(line);
  const marker = '#'.repeat(level);
  const content = existing ? line.slice(existing[0].length) : line;
  const nextLine = existing?.[1].length === level ? content : `${marker} ${content}`;
  const caretInContent = Math.max(0, start - bounds.start - (existing ? existing[0].length : 0));
  const nextCaret = bounds.start + (nextLine === content ? 0 : marker.length + 1) + caretInContent;
  return {
    text: text.slice(0, bounds.start) + nextLine + text.slice(bounds.end),
    selectionStart: nextCaret,
    selectionEnd: Math.min(nextCaret + (end - start), bounds.start + nextLine.length),
  };
}

const TABLE_SKELETON = '| Header | Header |\n| --- | --- |\n| Cell | Cell |';
const CODE_FENCE_SKELETON = '```\n\n```';

// Inserts a block snippet at the caret on lines of its own, keeping it clear of
// surrounding prose, and places the caret at `caretOffset` inside the snippet.
export function insertBlock(
  text: string,
  start: number,
  end: number,
  snippet: string,
  caretOffset: number,
): DraftEdit {
  const atLineStart = start === 0 || text[start - 1] === '\n';
  const rest = text.slice(end);
  const prefix = atLineStart ? '' : '\n';
  const suffix = rest.startsWith('\n') || rest === '' ? '' : '\n';
  const inserted = `${prefix}${snippet}${suffix}`;
  const caret = start + prefix.length + caretOffset;
  return {
    text: text.slice(0, start) + inserted + rest,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

// Wraps the selection as [text](url) and selects the URL placeholder. With
// nothing selected it offers a label placeholder selected instead, since that
// is what gets typed first.
export function insertLink(text: string, start: number, end: number): DraftEdit {
  const selected = text.slice(start, end);
  if (selected === '') {
    return {
      text: `${text.slice(0, start)}[label](url)${text.slice(end)}`,
      selectionStart: start + 1,
      selectionEnd: start + 6,
    };
  }
  const urlStart = start + 1 + selected.length + 2;
  return {
    text: `${text.slice(0, start)}[${selected}](url)${text.slice(end)}`,
    selectionStart: urlStart,
    selectionEnd: urlStart + 3,
  };
}

export function applyDraftFormat(
  text: string,
  start: number,
  end: number,
  action: DraftFormatAction,
): DraftEdit {
  switch (action) {
    case 'bold':
      return toggleWrap(text, start, end, '**');
    case 'italic':
      return toggleWrap(text, start, end, '*');
    case 'inlineCode':
      return toggleWrap(text, start, end, '`');
    case 'link':
      return insertLink(text, start, end);
    case 'heading1':
      return toggleHeading(text, start, end, 1);
    case 'heading2':
      return toggleHeading(text, start, end, 2);
    case 'heading3':
      return toggleHeading(text, start, end, 3);
    case 'bulletList':
      return toggleLinePrefix(text, start, end, '- ');
    case 'numberedList':
      return toggleLinePrefix(text, start, end, '1. ', true);
    case 'taskList':
      return toggleLinePrefix(text, start, end, '- [ ] ');
    case 'quote':
      return toggleLinePrefix(text, start, end, '> ');
    case 'table':
      return insertBlock(text, start, end, TABLE_SKELETON, 2);
    case 'codeBlock':
      return insertBlock(text, start, end, CODE_FENCE_SKELETON, 4);
  }
}

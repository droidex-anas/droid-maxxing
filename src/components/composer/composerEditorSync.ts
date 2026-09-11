// How text that did not come from typing reaches the editor: seeds, history
// recall, formatting actions, and queued prompts brought back for editing.
//
// Replacing the whole document would move the caret to the end and re-parse
// every line, so an external update is narrowed to the span that actually
// changed. CodeMirror then maps the existing selection through that span, which
// is what keeps the caret where the user left it.

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

// The single changed span between two texts: their common prefix and suffix are
// left untouched. Returns null when the texts already match.
export function diffEdit(current: string, next: string): TextEdit | null {
  if (current === next) return null;

  const shortest = Math.min(current.length, next.length);
  let from = 0;
  while (from < shortest && current[from] === next[from]) from += 1;

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > from && nextEnd > from && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return { from, to: currentEnd, insert: next.slice(from, nextEnd) };
}

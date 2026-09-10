// The prose a markdown source renders to, for the places that show a plain-text
// summary of draft text rather than rendering it: sidebar session titles and the
// queued-prompt row. Without this a draft that opens with markdown ("### HI",
// "**Fix** the `login`", a GFM table) shows its syntax instead of its meaning.
//
// Display-only by design: the stored text stays raw and recoverable. Underscores
// are left alone so snake_case names survive.

// A `| --- | :-- |` line carries no content once the pipes are gone.
const TABLE_DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[-:|\t ]*\|?[ \t]*$/gm;
// A table row reads as its cells; the separator keeps them from running together.
const TABLE_ROW = /^[ \t]*\|(.+)\|[ \t]*$/gm;

export function markdownToPlainText(source: string): string {
  const plain = source
    .replace(TABLE_DELIMITER_ROW, '')
    .replace(TABLE_ROW, (_row, cells: string) =>
      cells
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '')
        .join(' · '),
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/^#{1,6}\s+/gm, '') // ATX headings
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^[-*+]\s+\[[ xX]\]\s/gm, '') // task items
    .replace(/^[-*+]\s+/gm, '') // bullets
    .replace(/^\d+\.\s+/gm, '') // ordered items
    .replace(/\*\*|~~|`|\*/g, '') // emphasis, code, strikethrough
    .replace(/\s{2,}/g, ' ')
    .trim();
  return plain.length > 0 ? plain : source;
}

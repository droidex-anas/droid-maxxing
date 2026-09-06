export interface SourceLine {
  text: string;
  start: number;
  end: number;
  newline: string;
}

type FencePrefix = { kind: 'quote' } | { kind: 'list'; indent: number };

export interface OpenFence {
  marker: '`' | '~';
  length: number;
  info: string;
  prefixes: FencePrefix[];
}

export function iterateLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
    const contentEnd = index;
    if (source[index] === '\r' && source[index + 1] === '\n') index += 2;
    else if (source[index] === '\r' || source[index] === '\n') index += 1;
    lines.push({
      text: source.slice(start, contentEnd),
      start,
      end: index,
      newline: source.slice(contentEnd, index),
    });
  }
  return lines;
}

export function isClosedLine(line: SourceLine): boolean {
  return line.newline.length > 0;
}

export function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

export function isAtxHeading(text: string): boolean {
  return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(text);
}

export function isThematicBreak(text: string): boolean {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(text);
}

export function isSetextUnderline(text: string): boolean {
  return /^ {0,3}(?:=+|-+)[ \t]*$/.test(text);
}

export function isBlockquote(text: string): boolean {
  return /^ {0,3}>/.test(text);
}

export function listItemIndent(text: string): number | null {
  const match = /^( {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$))/.exec(text);
  return match ? match[1].length : null;
}

export function leadingIndent(text: string): number {
  const match = /^[ \t]*/.exec(text);
  return match ? match[0].length : 0;
}

export function continuesList(text: string, itemIndent: number): boolean {
  if (isBlank(text)) return true;
  if (listItemIndent(text) !== null) return true;
  return leadingIndent(text) >= itemIndent;
}

export function interruptsList(text: string): boolean {
  return (
    isAtxHeading(text) ||
    isThematicBreak(text) ||
    (openingFence(text) !== null && leadingIndent(text) < 2) ||
    isBlockquote(text)
  );
}

export function interruptsParagraph(text: string): boolean {
  return (
    isAtxHeading(text) ||
    isThematicBreak(text) ||
    openingFence(text) !== null ||
    listItemIndent(text) !== null ||
    isBlockquote(text)
  );
}

export function looksLikeTableRow(text: string): boolean {
  return text.includes('|');
}

export function isTableDelimiter(text: string): boolean {
  const cells = text.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (cells.length === 0 || !cells.includes('-')) return false;
  return cells.split('|').every((cell) => /^[ \t]*:?-{1,}[ \t]*:?[ \t]*$/.test(cell));
}

function openingFenceContainer(line: string): { content: string; prefixes: FencePrefix[] } {
  const prefixes: FencePrefix[] = [];
  let content = line;
  for (;;) {
    const quotePrefix = /^ {0,3}>[ \t]?/.exec(content)?.[0];
    if (quotePrefix) {
      prefixes.push({ kind: 'quote' });
      content = content.slice(quotePrefix.length);
      continue;
    }
    const listPrefix = /^( {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(content)?.[1];
    if (!listPrefix) break;
    prefixes.push({ kind: 'list', indent: listPrefix.length });
    content = content.slice(listPrefix.length);
  }
  return { content, prefixes };
}

function closingFenceContent(line: string, prefixes: FencePrefix[]): string | null {
  let content = line;
  for (const prefix of prefixes) {
    if (prefix.kind === 'quote') {
      const quote = /^ {0,3}>[ \t]?/.exec(content)?.[0];
      if (!quote) return null;
      content = content.slice(quote.length);
      continue;
    }
    const indent = /^[ \t]+/.exec(content)?.[0] ?? '';
    if (indent.length < prefix.indent) return null;
    content = content.slice(prefix.indent);
  }
  return content;
}

export function openingFence(line: string): OpenFence | null {
  const container = openingFenceContainer(line);
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(container.content);
  if (!opening) return null;
  const marker = opening[1].startsWith('`') ? '`' : '~';
  const infoWord = opening[2].trim().split(/\s+/, 1)[0] ?? '';
  return { marker, length: opening[1].length, info: infoWord, prefixes: container.prefixes };
}

export function closesFence(line: string, open: OpenFence): boolean {
  const content = closingFenceContent(line, open.prefixes);
  const closing = content ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content) : null;
  const ticks = closing?.[1];
  return ticks !== undefined && ticks.startsWith(open.marker) && ticks.length >= open.length;
}

export function nextNonBlank(
  lines: SourceLine[],
  start: number,
): { line: SourceLine; index: number } | null {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines.at(index);
    if (!line) continue;
    if (!isBlank(line.text)) return { line, index };
  }
  return null;
}

export function pendingFenceBody(pendingSource: string): string {
  const newlineAt = pendingSource.search(/\r\n|\n|\r/);
  if (newlineAt === -1) return '';
  const breakLength = pendingSource.startsWith('\r\n', newlineAt) ? 2 : 1;
  return pendingSource.slice(newlineAt + breakLength);
}

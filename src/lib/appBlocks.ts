export interface MarkdownAppFence {
  complete: boolean;
}

interface FenceContainer {
  content: string;
  quoteDepth: number;
  listIndent: number;
}

function openingFenceContainer(line: string): FenceContainer {
  const quotePrefix = /^ {0,3}((?:>[ \t]?)+)/.exec(line)?.[1] ?? '';
  const quoteDepth = quotePrefix.match(/>/g)?.length ?? 0;
  const afterQuote = line.slice(quotePrefix.length);
  const listPrefix = /^( {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(afterQuote)?.[1] ?? '';
  return {
    content: afterQuote.slice(listPrefix.length),
    quoteDepth,
    listIndent: listPrefix.length,
  };
}

function closingFenceContent(
  line: string,
  container: Pick<FenceContainer, 'quoteDepth' | 'listIndent'>,
): string | null {
  let content = line;
  for (let depth = 0; depth < container.quoteDepth; depth += 1) {
    const quote = /^ {0,3}>[ \t]?/.exec(content)?.[0];
    if (!quote) return null;
    content = content.slice(quote.length);
  }
  if (container.listIndent > 0) {
    const indent = /^[ \t]+/.exec(content)?.[0] ?? '';
    if (indent.length < container.listIndent) return null;
    content = content.slice(container.listIndent);
  }
  return content;
}

export function appFencesInMarkdown(markdown: string): MarkdownAppFence[] {
  const fences: MarkdownAppFence[] = [];
  let open: {
    marker: '`' | '~';
    length: number;
    isApp: boolean;
    quoteDepth: number;
    listIndent: number;
  } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (open) {
      const content = closingFenceContent(line, open);
      const closing = content ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content) : null;
      if (closing?.[1][0] === open.marker && closing[1].length >= open.length) {
        if (open.isApp) fences.push({ complete: true });
        open = null;
      }
      continue;
    }

    const container = openingFenceContainer(line);
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(container.content);
    if (!opening) continue;
    const marker = opening[1].startsWith('`') ? '`' : '~';
    const infoWord = opening[2].trim().split(/\s+/, 1)[0] ?? '';
    open = {
      marker,
      length: opening[1].length,
      isApp: infoWord === 'app',
      quoteDepth: container.quoteDepth,
      listIndent: container.listIndent,
    };
  }

  if (open?.isApp) fences.push({ complete: false });
  return fences;
}

export function hasAppBlock(markdown: string): boolean {
  return appFencesInMarkdown(markdown).length > 0;
}

export function hasCompleteAppBlock(markdown: string): boolean {
  return appFencesInMarkdown(markdown).some((fence) => fence.complete);
}

export function hasIncompleteAppBlock(markdown: string): boolean {
  return appFencesInMarkdown(markdown).some((fence) => !fence.complete);
}

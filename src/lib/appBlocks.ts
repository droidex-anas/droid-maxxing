export interface MarkdownAppFence {
  complete: boolean;
}

interface FenceContainer {
  content: string;
  prefixes: FenceContainerPrefix[];
}

type FenceContainerPrefix = { kind: 'quote' } | { kind: 'list'; indent: number };

function openingFenceContainer(line: string): FenceContainer {
  const prefixes: FenceContainerPrefix[] = [];
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

function closingFenceContent(line: string, prefixes: FenceContainerPrefix[]): string | null {
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

export function appFencesInMarkdown(markdown: string): MarkdownAppFence[] {
  const fences: MarkdownAppFence[] = [];
  let open: {
    marker: '`' | '~';
    length: number;
    isApp: boolean;
    prefixes: FenceContainerPrefix[];
  } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (open) {
      const content = closingFenceContent(line, open.prefixes);
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
      prefixes: container.prefixes,
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

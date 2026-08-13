export interface MarkdownAppFence {
  complete: boolean;
}

export function appFencesInMarkdown(markdown: string): MarkdownAppFence[] {
  const fences: MarkdownAppFence[] = [];
  let open: { marker: '`' | '~'; length: number; isApp: boolean } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (open) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing?.[1][0] === open.marker && closing[1].length >= open.length) {
        if (open.isApp) fences.push({ complete: true });
        open = null;
      }
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!opening) continue;
    const marker = opening[1].startsWith('`') ? '`' : '~';
    const infoWord = opening[2].trim().split(/\s+/, 1)[0] ?? '';
    open = {
      marker,
      length: opening[1].length,
      isApp: infoWord === 'app',
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

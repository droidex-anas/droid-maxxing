export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
}

// Headings (h1–h3) of a markdown spec. The id matches the slug the markdown
// renderer assigns to the heading element, so outline entries can scroll to
// their section.
export function extractOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    headings.push({ level: match[1].length, text, id });
  }
  return headings;
}

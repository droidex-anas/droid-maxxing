const SNIPPET_RADIUS = 48;

export function buildSessionSearchSnippet(text: string, queryLower: string): string | null {
  const index = text.toLowerCase().indexOf(queryLower);
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + queryLower.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

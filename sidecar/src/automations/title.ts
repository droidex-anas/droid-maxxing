const MAX_TITLE_LENGTH = 72;

export function deriveAutomationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Scheduled task';
  // A sentence ends at punctuation followed by a space or the end of the text, so
  // a version number such as "ship v1.5 today" stays intact.
  const boundary = compact.search(/[.!?](\s|$)/);
  const firstSentence = (boundary > 0 ? compact.slice(0, boundary) : compact).trim();
  const cleaned = firstSentence
    .replace(/^(please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+)/i, '')
    .trim();
  const candidate = cleaned || firstSentence;
  // Iterating code points keeps an emoji or other astral character whole.
  const points = Array.from(candidate);
  if (points.length <= MAX_TITLE_LENGTH) return candidate;
  return `${points
    .slice(0, MAX_TITLE_LENGTH - 3)
    .join('')
    .trimEnd()}…`;
}

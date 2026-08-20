// A queued row is a compact reminder of what will send next, not a second
// transcript: a long or multi-paragraph prompt would otherwise push the
// composer off screen. The full text stays reachable by editing the prompt.

export const QUEUED_PREVIEW_MAX_CHARS = 120;

/**
 * One-line, length-capped preview of a queued prompt. Newlines and runs of
 * whitespace collapse to single spaces so the row height stays predictable, and
 * the cut lands on a word boundary when one is close to the limit.
 */
export function queuedPromptPreview(text: string, maxChars = QUEUED_PREVIEW_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  const cut = collapsed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honor a word boundary in the last quarter; an early space would throw
  // away most of the preview.
  const kept = lastSpace > maxChars * 0.75 ? cut.slice(0, lastSpace) : cut.trimEnd();
  return `${kept}…`;
}

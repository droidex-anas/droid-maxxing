import { composePrompt } from './composePrompt';

/**
 * Inverse of the @file block composePrompt appends. Sent messages carry their
 * attachments as structured metadata, but a message replayed from history is
 * just the composed string, so the trailing mention block would otherwise render
 * as a wall of raw paths in the bubble.
 *
 * Only a final paragraph made entirely of @mentions is claimed, which is exactly
 * what composePrompt produces; prose that merely contains an @word is left alone.
 */
export function splitTrailingMentions(text: string): { text: string; files: string[] } {
  const paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1]?.trim() ?? '';
  if (!last.startsWith('@')) return { text, files: [] };
  // composePrompt joins `@path` tokens with a single space. Paths themselves may
  // contain spaces, so split on ` @` rather than any whitespace.
  const files = last.slice(1).split(' @');
  if (files.some((file) => file.length === 0 || /[\n\r]/.test(file))) {
    return { text, files: [] };
  }
  return {
    text: paragraphs.slice(0, -1).join('\n\n'),
    files,
  };
}

/**
 * Presentation view of a user message: attachments come from the event when it
 * was sent in this session, and from the composed text when it was replayed from
 * history. Guarded by a round-trip through composePrompt so the split only
 * applies to text this app actually composed.
 */
export function userMessageAttachments(
  text: string | undefined,
  files: readonly string[] | undefined,
): { text: string; files: string[] } {
  if (files && files.length > 0) return { text: text ?? '', files: [...files] };
  const split = splitTrailingMentions(text ?? '');
  if (split.files.length === 0) return { text: text ?? '', files: [] };
  if (composePrompt(split.text, [], split.files) !== text) return { text: text ?? '', files: [] };
  return split;
}

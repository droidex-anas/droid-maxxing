import { composePrompt } from './composePrompt';

/**
 * Whether a recovered mention names a file rather than a person or a word. An
 * attachment is either a path with a separator or a file name with an extension,
 * and never spans lines; a typed sign-off like "@anas" is neither, so it stays
 * prose in the bubble.
 */
function looksLikeAttachmentPath(mention: string): boolean {
  if (mention.includes('\n')) return false;
  return mention.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(mention);
}

/**
 * Inverse of the @file block composePrompt appends. Sent messages carry their
 * attachments as structured metadata, but a message replayed from history is
 * just the composed string, so the trailing mention block would otherwise render
 * as a wall of raw paths in the bubble.
 *
 * Only a final paragraph made entirely of @path mentions is claimed, which is
 * exactly what composePrompt produces; prose that merely contains an @word is
 * left alone. Mentions are separated at the ` @` boundary rather than on any
 * whitespace, so an attached path containing spaces survives the round trip. A
 * path that itself contains ` @` is the one case this cannot resolve, and it
 * splits into two mentions.
 */
export function splitTrailingMentions(text: string): { text: string; files: string[] } {
  const paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1] ?? '';
  if (!last.startsWith('@')) return { text, files: [] };
  const files = last.split(/ (?=@)/).map((mention) => mention.slice(1));
  if (!files.every(looksLikeAttachmentPath)) return { text, files: [] };
  return { text: paragraphs.slice(0, -1).join('\n\n'), files };
}

/**
 * Presentation view of a user message: attachments come from the event when it
 * was sent in this session, and from the composed text when it was replayed from
 * history. Guarded by a round-trip through composePrompt so the split only
 * applies to text this app actually composes.
 *
 * A defined files array is authoritative even when empty: live optimistic
 * events always carry it, while restored history omits it. That distinction
 * prevents typed mention-shaped prose from being claimed as attachments.
 */
export function userMessageAttachments(
  text: string | undefined,
  files: readonly string[] | undefined,
): { text: string; files: string[] } {
  if (files !== undefined) return { text: text ?? '', files: [...files] };
  const split = splitTrailingMentions(text ?? '');
  if (split.files.length === 0) return { text: text ?? '', files: [] };
  if (composePrompt(split.text, [], split.files) !== text) return { text: text ?? '', files: [] };
  return split;
}

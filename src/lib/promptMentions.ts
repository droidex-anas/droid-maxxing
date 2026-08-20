import { composePrompt } from './composePrompt';

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
  // A path always carries a separator and never a line break; requiring both
  // keeps a typed sign-off like "@anas" and hand-written mention lists from being
  // mistaken for attachments the user never selected.
  if (!files.every((file) => file.includes('/') && !file.includes('\n'))) {
    return { text, files: [] };
  }
  return { text: paragraphs.slice(0, -1).join('\n\n'), files };
}

/**
 * Presentation view of a user message: attachments come from the event when it
 * was sent in this session, and from the composed text when it was replayed from
 * history. Guarded by a round-trip through composePrompt so the split only
 * applies to text this app actually composes.
 *
 * The round trip proves format, not provenance: a live message whose final
 * paragraph is nothing but @path mentions is indistinguishable from a composed
 * one, so it renders as attachment chips too. That is accepted rather than
 * plumbed around — the chips name exactly the paths the paragraph contained, and
 * the prose above them is untouched.
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

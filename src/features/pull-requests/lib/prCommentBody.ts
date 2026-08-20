// GitHub comment bodies are Markdown with a little HTML in them: review bots
// wrap machine-readable prompts in <details>, footers in <sub>, and links in
// anchors. Rendering that raw leaves walls of pseudo-XML in the conversation, so
// a body is split into prose and collapsible disclosures, and the inline HTML
// that survives is translated into Markdown.

export type PrCommentBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'disclosure'; summary: string; body: string };

const DETAILS = /<details\b[^>]*>([\s\S]*?)<\/details>/gi;
const SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i;
const ANCHOR = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function inlineText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fenced code is content, not markup: transformations skip it so a review
// prompt full of angle brackets survives untouched.
function mapOutsideFences(text: string, transform: (chunk: string) => string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}

function isPromoFooter(text: string): boolean {
  return /free plan|upgrade for unlimited reviews|re-trigger cubic/i.test(text);
}

// `<sub>`/`<sup>` carry bot footers: keep the sentence, drop the sales pitch.
function unwrapSmallText(_match: string, content: string): string {
  const text = inlineText(content.replace(/<br\s*\/?\s*>/gi, ' '));
  return isPromoFooter(text) ? '' : text;
}

// Images go first so a badge wrapped in a link (`Review in cubic`) leaves an
// empty anchor, which is dropped rather than becoming an unlabelled link.
function markdownFromHtml(chunk: string): string {
  return chunk
    .replace(/<su[bp]\b[^>]*>([\s\S]*?)<\/su[bp]>/gi, unwrapSmallText)
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(ANCHOR, (_match, href: string, label: string) => {
      const text = inlineText(label);
      return text ? `[${text}](${href})` : '';
    })
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n\n');
}

function normalizeBlock(text: string): string {
  return mapOutsideFences(text, markdownFromHtml)
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function disclosure(inner: string): PrCommentBlock | null {
  const summary = SUMMARY.exec(inner);
  const body = normalizeBlock(inner.replace(SUMMARY, ''));
  const label = summary ? inlineText(summary[1]) : 'Details';
  if (!body && !label) return null;
  return { kind: 'disclosure', summary: label || 'Details', body };
}

function markdown(text: string): PrCommentBlock | null {
  const normalized = normalizeBlock(text);
  return normalized ? { kind: 'markdown', text: normalized } : null;
}

export function prCommentBlocks(raw: string): PrCommentBlock[] {
  const body = raw.replace(/<!--[\s\S]*?-->/g, '');
  const blocks: PrCommentBlock[] = [];
  let cursor = 0;
  for (const match of body.matchAll(DETAILS)) {
    const start = match.index;
    const prose = markdown(body.slice(cursor, start));
    if (prose) blocks.push(prose);
    const collapsed = disclosure(match[1]);
    if (collapsed) blocks.push(collapsed);
    cursor = start + match[0].length;
  }
  const tail = markdown(body.slice(cursor));
  if (tail) blocks.push(tail);
  return blocks;
}

// What the comment actually says, ignoring the disclosures. This is what
// decides whether a comment is long enough to fold and what its preview shows.
export function prCommentProse(blocks: readonly PrCommentBlock[]): string {
  return blocks
    .filter((block): block is { kind: 'markdown'; text: string } => block.kind === 'markdown')
    .map((block) => block.text)
    .join('\n\n');
}

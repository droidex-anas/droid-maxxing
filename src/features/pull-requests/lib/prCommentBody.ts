// GitHub comment bodies are Markdown with a little HTML in them: review bots
// wrap machine-readable prompts in <details>, footers in <sub>, and links in
// anchors. Rendering that raw leaves walls of pseudo-XML in the conversation, so
// a body is split into prose and collapsible disclosures, and the inline HTML
// that survives is translated into Markdown.

export type PrCommentBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'disclosure'; summary: string; body: string };

const DETAILS_TAG = /<(\/?)details\b[^>]*>/gi;
const SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i;
const ANCHOR = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function inlineText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FenceSpan {
  start: number;
  end: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// CommonMark fences: three or more backticks or tildes, closed by a run of the
// same character at least as long. An unterminated fence runs to the end.
function fenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open: { fence: string; start: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    if (!open) {
      const fence = FENCE_OPEN.exec(line);
      if (fence) open = { fence: fence[1], start: offset };
    } else {
      // Starting with the opening run means the same character, at least as long.
      const closing = FENCE_CLOSE.exec(line)?.[1] ?? '';
      if (closing.startsWith(open.fence)) {
        spans.push({ start: open.start, end });
        open = null;
      }
    }
    offset = end + 1;
  }
  if (open) spans.push({ start: open.start, end: text.length });
  return spans;
}

// Fenced code is content, not markup: transformations skip it so a review
// prompt full of angle brackets survives untouched.
function mapOutsideFences(text: string, transform: (chunk: string) => string): string {
  let out = '';
  let cursor = 0;
  for (const span of fenceSpans(text)) {
    out += transform(text.slice(cursor, span.start)) + text.slice(span.start, span.end);
    cursor = span.end;
  }
  return out + transform(text.slice(cursor));
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
  return (
    chunk
      .replace(/<su[bp]\b[^>]*>([\s\S]*?)<\/su[bp]>/gi, unwrapSmallText)
      .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(ANCHOR, (_match, href: string, label: string) => {
        const text = inlineText(label);
        return text ? `[${text}](${href})` : '';
      })
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/?p\b[^>]*>/gi, '\n\n')
      // Nested or unbalanced disclosure markup would otherwise leak as literal
      // tags: keep the text, drop the tag.
      .replace(/<\/?(?:details|summary)\b[^>]*>/gi, '')
  );
}

// Blank runs are collapsed outside fences only, so a code sample keeps the
// blank lines it was written with.
function normalizeBlock(text: string): string {
  return mapOutsideFences(text, (chunk) =>
    markdownFromHtml(chunk)
      .replace(/\n[ \t]+\n/g, '\n\n')
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
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

interface DetailsSection {
  start: number;
  end: number;
  inner: string;
}

// Outermost `<details>` pairs, matched by depth so a nested disclosure stays
// inside its parent instead of ending it early. Fenced markup is content.
function detailsSections(text: string): DetailsSection[] {
  const spans = fenceSpans(text);
  const sections: DetailsSection[] = [];
  let depth = 0;
  let start = 0;
  let innerStart = 0;
  for (const match of text.matchAll(DETAILS_TAG)) {
    const index = match.index;
    if (spans.some((span) => index >= span.start && index < span.end)) continue;
    if (match[1] === '/') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) {
        sections.push({
          start,
          end: index + match[0].length,
          inner: text.slice(innerStart, index),
        });
      }
      continue;
    }
    if (depth === 0) {
      start = index;
      innerStart = index + match[0].length;
    }
    depth += 1;
  }
  return sections;
}

export function prCommentBlocks(raw: string): PrCommentBlock[] {
  // Both the comment strip and the disclosure scan stay outside fences: an
  // `<!-- -->` or a `<details>` shown inside a code sample is documentation.
  const body = mapOutsideFences(raw, (chunk) => chunk.replace(/<!--[\s\S]*?-->/g, ''));
  const blocks: PrCommentBlock[] = [];
  let cursor = 0;
  for (const section of detailsSections(body)) {
    const prose = markdown(body.slice(cursor, section.start));
    if (prose) blocks.push(prose);
    const collapsed = disclosure(section.inner);
    if (collapsed) blocks.push(collapsed);
    cursor = section.end;
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

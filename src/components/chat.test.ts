import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildFeed,
  fetchSizeBadge,
  groupTurns,
  MessageFeed,
  StreamingCaret,
  UserBubble,
  WebFetchBody,
  type FeedItem,
} from './chat';
import { EarlierHistoryControl, isConversationOpeningSettling } from './ChatView';
import {
  createDiffDisclosure,
  mountNextRevealedDiffCards,
  nextDiffCardCount,
  reopenDiffDisclosure,
  revealNextDiffCards,
} from '../lib/diff';
import { parseTruncatedTail } from '../lib/tools';
import type { TranscriptEvent } from '../types/bridge';

let seq = 0;
function ev(extra: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: `e${seq++}`,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: seq,
    kind: 'text',
    ...extra,
  } as TranscriptEvent;
}

const userMsg = (text: string) => ev({ kind: 'text', author: 'user', text });
const asst = (text: string) => ev({ kind: 'text', text });
const todo = (todos: string) =>
  ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos } });

function topLevelAnswers(items: FeedItem[]): string[] {
  return items
    .filter((it): it is Extract<FeedItem, { type: 'message' }> => it.type === 'message')
    .filter((it) => it.event.author !== 'user')
    .map((it) => it.event.text ?? '');
}

test('a skill prompt renders the skill inline in blue before the user text', () => {
  const html = renderToStaticMarkup(
    createElement(UserBubble, { event: { text: 'PR #100', skills: ['review'] } }),
  );
  assert.match(html, /text-droid-skill[^>]*>.*review/);
  assert.ok(html.indexOf('review') < html.indexOf('PR #100'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('violet'));
});

test('#14 a normal assistant response still renders in chat while a spec exists', () => {
  const events = [userMsg('hi'), asst('a perfectly normal answer')];
  const html = renderToStaticMarkup(
    createElement(MessageFeed, {
      events,
      pending: false,
      specContent: '# Specification\n\nSome unrelated spec doc',
    }),
  );
  // The normal answer is NOT swallowed by the spec surface just because spec
  // content is present (the old blanket spec-draft suppression bug).
  assert.ok(html.includes('a perfectly normal answer'));
});

test('restored feed rows render immediately instead of replaying entrance motion', () => {
  const events = [userMsg('hi'), asst('restored answer')];
  const html = renderToStaticMarkup(createElement(MessageFeed, { events, pending: false }));

  assert.doesNotMatch(html, /opacity:\s*0/);
  assert.doesNotMatch(html, /translateY\(4px\)/);
});

test('App responses receive a wider chat canvas while ordinary rows stay readable', () => {
  const app = 'Here is the result.\n\n```app\n<main>Wide App</main>\n```';
  const appHtml = renderToStaticMarkup(
    createElement(MessageFeed, { events: [asst(app)], pending: false }),
  );
  const textHtml = renderToStaticMarkup(
    createElement(MessageFeed, { events: [asst('Ordinary answer')], pending: false }),
  );

  assert.match(appHtml, /max-w-4xl/);
  assert.match(textHtml, /max-w-2xl/);
});

test('an incomplete live App owns its building state without exposing Play or a trailing caret', () => {
  const incompleteApp = [
    'Preparing the visualization.',
    '',
    '```app',
    '<main><script>const points = [',
  ].join('\n');
  const html = renderToStaticMarkup(
    createElement(MessageFeed, { events: [asst(incompleteApp)], pending: true }),
  );

  assert.match(html, /max-w-4xl/);
  assert.match(html, /Building interactive app/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /aria-label="Play app"/);
  assert.doesNotMatch(html, /caret-blink/);
  assert.doesNotMatch(html, /<iframe/i);
});

test('ordinary live prose keeps the trailing streaming caret', () => {
  const html = renderToStaticMarkup(
    createElement(MessageFeed, { events: [asst('Still writing')], pending: true }),
  );

  assert.match(html, /caret-blink/);
});

test('live thinking stays collapsed until the user opens it', () => {
  const events = [
    userMsg('inspect this'),
    ev({ kind: 'thinking', text: 'private live reasoning detail' }),
  ];
  const html = renderToStaticMarkup(createElement(MessageFeed, { events, pending: true }));

  assert.ok(html.includes('Thinking'));
  assert.equal(html.includes('private live reasoning detail'), false);
});

test('#14 an assistant message that is exactly the spec text is not double-rendered in chat', () => {
  const spec = '# Specification\n\nThe one and only spec body';
  const events = [userMsg('hi'), asst(spec)];
  const html = renderToStaticMarkup(
    createElement(MessageFeed, { events, pending: false, specContent: spec }),
  );
  // The pinned spec card is present (its title renders)...
  assert.ok(html.includes('Specification'));
  // ...and the identical assistant message is suppressed from the chat stream,
  // so the spec body is not duplicated as a normal chat row (the card body is
  // collapsed by default, hence absent here).
  const occurrences = html.split('The one and only spec body').length - 1;
  assert.equal(occurrences, 0);
});

test('diff disclosure grows in bounded renderer commits', () => {
  assert.equal(nextDiffCardCount(50, 500), 100);
  assert.equal(nextDiffCardCount(100, 125), 125);
  assert.equal(nextDiffCardCount(125, 125), 125);
});

test('diff disclosure preserves reveal progress while remounting in bounded commits', () => {
  let disclosure = createDiffDisclosure(500);
  for (let count = 50; count < 200; count += 50) {
    disclosure = revealNextDiffCards(disclosure, 500);
    disclosure = mountNextRevealedDiffCards(disclosure, 500);
  }
  assert.deepEqual(disclosure, { revealedCount: 200, mountedCount: 200 });

  disclosure = reopenDiffDisclosure(disclosure, 500);
  assert.deepEqual(disclosure, { revealedCount: 200, mountedCount: 50 });

  for (let count = 50; count < 200; count += 50) {
    disclosure = mountNextRevealedDiffCards(disclosure, 500);
    assert.equal(disclosure.mountedCount, count + 50);
    assert.equal(disclosure.revealedCount, 200);
  }
});

test('opening an old chat keeps the skeleton up until timeline priming settles', () => {
  const settling = {
    isConversationLive: false,
    isViewingChildSession: false,
    isTimelinePriming: true,
    hasOlderHistory: true,
    isLoadingOlder: false,
  };
  assert.equal(isConversationOpeningSettling(settling), true);
  // The last priming page is still in flight after the cursor was consumed.
  assert.equal(
    isConversationOpeningSettling({ ...settling, hasOlderHistory: false, isLoadingOlder: true }),
    true,
  );
  // Enough anchors: the rail is ready, the feed takes over.
  assert.equal(isConversationOpeningSettling({ ...settling, isTimelinePriming: false }), false);
  // History exhausted with nothing in flight: a short thread never re-covers.
  assert.equal(isConversationOpeningSettling({ ...settling, hasOlderHistory: false }), false);
  // Streaming output outranks a quiet open.
  assert.equal(isConversationOpeningSettling({ ...settling, isConversationLive: true }), false);
  assert.equal(isConversationOpeningSettling({ ...settling, isViewingChildSession: true }), false);
});

test('history paging uses a persistent live region whose text changes in place', () => {
  const idle = renderToStaticMarkup(
    createElement(EarlierHistoryControl, { hasMore: true, loading: false }),
  );
  const loading = renderToStaticMarkup(
    createElement(EarlierHistoryControl, { hasMore: true, loading: true }),
  );
  const exhausted = renderToStaticMarkup(
    createElement(EarlierHistoryControl, { hasMore: false, loading: false }),
  );

  for (const markup of [idle, loading, exhausted]) {
    assert.match(markup, /aria-atomic="true"/);
    assert.match(markup, /aria-live="polite"/);
    assert.doesNotMatch(markup, /<button/);
  }
  // While more history exists the row holds its height so an arriving page
  // never nudges the reading position; only the in-flight state speaks.
  assert.match(idle, /h-9/);
  assert.doesNotMatch(idle, /Loading earlier messages/);
  assert.match(loading, /Loading earlier messages…/);
  assert.doesNotMatch(exhausted, /Loading earlier messages/);
});

test('#19/#14 a spec fragment split by reconciliation is not merged into prose', () => {
  // prose -> TodoWrite reconciliation -> exact spec text. The #19 merge must NOT
  // fold the spec fragment into the prose, or the merged row would no longer
  // match the spec exactly and FeedItemView would render the spec body twice.
  const spec = '# Specification\n\nThe sole spec body line';
  const events = [
    userMsg('draft the spec'),
    asst('Here is the plan.'),
    todo('1. [completed] x'),
    asst(spec),
  ];
  const grouped = groupTurns(buildFeed(events), false, spec);
  // The spec fragment stays its own top-level message (exact match, suppressible)
  // and is never concatenated onto the prose.
  assert.deepEqual(topLevelAnswers(grouped), ['Here is the plan.', spec]);
  const html = renderToStaticMarkup(
    createElement(MessageFeed, { events, pending: false, specContent: spec }),
  );
  assert.ok(html.includes('Here is the plan.'));
  assert.equal(html.split('The sole spec body line').length - 1, 0);
});

test('parseTruncatedTail splits the history truncation sentinel from the body', () => {
  const { body, truncatedChars } = parseTruncatedTail('Answer text.\n\n[truncated 1252663 chars]');
  assert.equal(body, 'Answer text.');
  assert.equal(truncatedChars, 1252663);
});

test('parseTruncatedTail leaves untruncated text untouched', () => {
  const { body, truncatedChars } = parseTruncatedTail('Just a normal answer.');
  assert.equal(body, 'Just a normal answer.');
  assert.equal(truncatedChars, null);
});

test('MessageFeed strips the truncation sentinel and shows no truncation note', () => {
  const events = [userMsg('hi'), asst('Big answer body.\n\n[truncated 2048 chars]')];
  const html = renderToStaticMarkup(createElement(MessageFeed, { events, pending: false }));
  assert.ok(html.includes('Big answer body.'));
  assert.equal(html.includes('[truncated'), false);
  assert.equal(html.includes('characters truncated'), false);
});

test('fetch size badge counts the truncated-away characters', () => {
  // The sentinel's number is the omitted character count, so a kept 10-char
  // body with 4096 omitted chars must badge the full fetched size, not "10+".
  assert.equal(fetchSizeBadge(10, 4096), '4.1k+');
  assert.equal(fetchSizeBadge(10, null), '10');
  assert.equal(fetchSizeBadge(0, null), null);
});

test('a short fetched page body renders its URLs as links outside the source row', () => {
  // Bodies within the snippet threshold render only as the snippet (no
  // separate body block), so the snippet must linkify — otherwise URLs in a
  // short fetched page are plain text and not clickable. But the source row
  // is itself an anchor, so the linkified snippet must render outside it:
  // nested anchors are invalid HTML and a click would open both links.
  const body = 'See https://example.com/docs for the full guide.';
  const html = renderToStaticMarkup(
    createElement(WebFetchBody, {
      error: false,
      hasBody: true,
      body,
      url: 'https://example.com',
      title: 'Example',
      snippet: body,
    }),
  );
  const rowClose = html.indexOf('</a>');
  const snippetLink = html.indexOf('href="https://example.com/docs"');
  assert.ok(rowClose !== -1);
  assert.ok(snippetLink > rowClose);
});

test('a fetched page body never renders an svg fence as inline markup', () => {
  // Regression: fetched pages are untrusted, so ```svg blocks must render as
  // plain code, never through SvgCodeBlock's unsanitized dangerouslySetInnerHTML.
  const body = `${'Intro text. '.repeat(30)}\n\n\`\`\`svg\n<svg onload="alert(1)"><rect width="10" height="10"/></svg>\n\`\`\`\n`;
  const html = renderToStaticMarkup(
    createElement(WebFetchBody, {
      error: false,
      hasBody: true,
      body,
      url: 'https://evil.example',
      title: 'Evil',
      snippet: 'Intro text.',
    }),
  );
  assert.equal(html.includes('<svg onload'), false);
  // The fence survives only as escaped text inside a plain code card.
  assert.ok(html.includes('&lt;svg'));
});

test('StreamingCaret renders a plain span carrying the caret-blink CSS class', () => {
  const html = renderToStaticMarkup(createElement(StreamingCaret));
  assert.ok(html.startsWith('<span '), 'caret should render as a plain span');
  assert.ok(html.includes('class="caret-blink '), 'caret should carry the caret-blink class');
  assert.ok(html.includes('w-[2px]'), 'caret should keep its 2px width');
  assert.ok(html.includes('h-[1.05em]'), 'caret should keep its 1.05em height');
  assert.ok(
    html.includes('background:var(--droid-accent)'),
    'caret should keep the accent background',
  );
});

// The infinite status indicators (caret blink, shimmer) must honor
// prefers-reduced-motion so the UI stays usable for motion-sensitive users.
test('caret-blink is neutralized under prefers-reduced-motion', () => {
  const cssPath = fileURLToPath(new URL('../index.css', import.meta.url));
  const css = readFileSync(cssPath, 'utf8');
  const reducedMotionBlocks =
    css.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{[^}]*\}/g) ?? [];
  const coversCaretBlink = reducedMotionBlocks.some((block) => /\.caret-blink\b/.test(block));
  assert.ok(coversCaretBlink, 'a prefers-reduced-motion block must disable .caret-blink');
});

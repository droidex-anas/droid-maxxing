import assert from 'node:assert/strict';
import test from 'node:test';

import { prCommentBlocks, prCommentProse } from './prCommentBody';

const CUBIC_REVIEW = `<!-- cubic:review-summary:start -->
**2 issues found** across 17 files
<!-- cubic:review-summary:end -->

<details>
<summary>Prompt for AI agents (unresolved issues)</summary>

\`\`\`text
<file name="src/App.tsx">
<violation number="1" location="src/App.tsx:291">P2: Share the onboarding state.</violation>
</file>
\`\`\`

</details>

<sub>Reply with feedback.<br /><br />[Re-trigger cubic](https://www.cubic.dev/action/re-review/pr/o/r/1)</sub>`;

test('a bot review keeps its prose and folds the agent prompt away', () => {
  const blocks = prCommentBlocks(CUBIC_REVIEW);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['markdown', 'disclosure'],
  );
  assert.equal(
    blocks[0].kind === 'markdown' ? blocks[0].text : '',
    '**2 issues found** across 17 files',
  );
  if (blocks[1].kind !== 'disclosure') throw new Error('expected a disclosure');
  assert.equal(blocks[1].summary, 'Prompt for AI agents (unresolved issues)');
  // Angle brackets inside the fence are content, so they survive verbatim.
  assert.match(blocks[1].body, /<violation number="1" location="src\/App\.tsx:291">/);
  // The promotional footer never reaches the conversation.
  assert.doesNotMatch(prCommentProse(blocks), /Re-trigger cubic/);
});

test('the prose ignores disclosures so folding follows what the comment says', () => {
  const blocks = prCommentBlocks(
    'Short remark.\n\n<details><summary>Payload</summary>\n\nx\n</details>',
  );
  assert.equal(prCommentProse(blocks), 'Short remark.');
});

test('a generated description drops its badge link, footer, and end marker', () => {
  const body = `<!-- This is an auto-generated description by cubic. -->
---
## Summary by cubic
Shows pasted images instead of broken glyphs.

<sup>Written for commit 7387c06. Summary will update on new commits.</sup>

<a href="https://cubic.dev/pr/o/r/pull/114?utm_source=github" target="_blank" rel="noopener noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.cubic.dev/buttons/review-in-cubic-dark.svg"><img alt="Review in cubic" src="https://www.cubic.dev/buttons/review-in-cubic-dark.svg"></picture></a>

<!-- End of auto-generated description by cubic. -->`;

  const blocks = prCommentBlocks(body);

  assert.equal(blocks.length, 1);
  const text = blocks[0].kind === 'markdown' ? blocks[0].text : '';
  assert.match(text, /## Summary by cubic/);
  assert.match(text, /Written for commit 7387c06\./);
  // The badge is an image inside a link: neither survives as raw markup or as
  // an empty link.
  assert.doesNotMatch(text, /<a |<picture|<img|<sup|href=|\[\]\(/);
  assert.doesNotMatch(text, /auto-generated description/);
});

test('inline anchors become markdown links and images are dropped', () => {
  const blocks = prCommentBlocks(
    'See <a href="https://example.test/x">the docs</a> <img src="https://example.test/i.png" alt="i" />',
  );
  assert.equal(blocks.length, 1);
  assert.equal(
    blocks[0].kind === 'markdown' ? blocks[0].text : '',
    'See [the docs](https://example.test/x)',
  );
});

test('a details block without a summary still folds under a label', () => {
  const blocks = prCommentBlocks('<details>\n\nhidden\n</details>');
  assert.deepEqual(blocks, [{ kind: 'disclosure', summary: 'Details', body: 'hidden' }]);
});

test('markup shown inside a fence is a code sample, not markup', () => {
  const body = [
    'How the marker looks:',
    '',
    '~~~html',
    '<!-- cubic:review-summary:start -->',
    '<details>',
    '<summary>Not a real disclosure</summary>',
    '</details>',
    '~~~',
  ].join('\n');
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('a longer fence closes only on a run at least as long', () => {
  const body = ['````md', '```ts', 'const a = 1;', '```', '````'].join('\n');
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('blank lines inside a fence survive normalization', () => {
  const body = ['```ts', 'const a = 1;', '', '', 'const b = 2;', '```'].join('\n');
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('a nested disclosure stays inside its parent', () => {
  const blocks = prCommentBlocks(
    '<details><summary>Outer</summary>\n\nintro\n\n<details><summary>Inner</summary>\n\ndeep\n</details>\n</details>\n\nafter',
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['disclosure', 'markdown'],
  );
  if (blocks[0].kind !== 'disclosure') throw new Error('expected a disclosure');
  assert.equal(blocks[0].summary, 'Outer');
  assert.match(blocks[0].body, /intro/);
  assert.match(blocks[0].body, /deep/);
  assert.doesNotMatch(blocks[0].body, /<details|<\/details|<summary/);
  assert.equal(blocks[1].kind === 'markdown' ? blocks[1].text : '', 'after');
});

test('an unbalanced disclosure tag never reaches the prose', () => {
  const blocks = prCommentBlocks('Notes\n\n<details>\n\nunclosed');
  assert.deepEqual(blocks, [{ kind: 'markdown', text: 'Notes\n\nunclosed' }]);
});

test('ordinary markdown passes through untouched', () => {
  const body = 'Please preserve **this decision**.\n\n- First\n- Second';
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('a CRLF closing fence closes, so only markup after it is markup', () => {
  const body = [
    'Sample:',
    '',
    '```html',
    '<details><summary>not real</summary></details>',
    '```',
    '',
    '<details><summary>real</summary>',
    'payload',
    '</details>',
    '',
    'See <a href="https://example.test/a">the docs</a>',
  ].join('\r\n');
  const blocks = prCommentBlocks(body);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['markdown', 'disclosure', 'markdown'],
  );
  const sample = blocks[0].kind === 'markdown' ? blocks[0].text : '';
  assert.match(sample, /<summary>not real<\/summary>/);
  const after = blocks[2].kind === 'markdown' ? blocks[2].text : '';
  assert.match(after, /\[the docs\]\(https:\/\/example\.test\/a\)/);
});

test('markup inside inline code spans is content, not markup', () => {
  const body = 'Write `<details>` (or `` `<summary>` ``) to fold a section.';
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('indented code blocks are content, not markup', () => {
  const body = [
    'Example:',
    '',
    '    <details>',
    '    <summary>sample</summary>',
    '    </details>',
    '',
    'Done.',
  ].join('\n');
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('a details tag with nothing in it does not become a disclosure', () => {
  assert.deepEqual(prCommentBlocks('<details></details>'), []);
  assert.deepEqual(prCommentBlocks('<details> \n </details>'), []);
  assert.deepEqual(prCommentBlocks('<details><summary>  </summary></details>tail'), [
    { kind: 'markdown', text: 'tail' },
  ]);
});

test('a longer backtick run cannot close a shorter inline code span', () => {
  const body = '``code ``` <details><summary>still code</summary>payload</details> `` after';
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

test('summary markup inside disclosure code stays in the disclosure body', () => {
  const fenced = [
    '<details>',
    '<summary>Real label</summary>',
    '',
    '```html',
    '<summary>sample label</summary>',
    '```',
    '</details>',
  ].join('\n');
  const indented = [
    '<details>',
    '<summary>Real label</summary>',
    '',
    '    <summary>sample label</summary>',
    '</details>',
  ].join('\n');

  for (const body of [fenced, indented]) {
    const blocks = prCommentBlocks(body);
    assert.equal(blocks.length, 1);
    if (blocks[0].kind !== 'disclosure') throw new Error('expected a disclosure');
    assert.equal(blocks[0].summary, 'Real label');
    assert.match(blocks[0].body, /<summary>sample label<\/summary>/);
  }
});

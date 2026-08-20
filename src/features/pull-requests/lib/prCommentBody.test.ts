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

test('ordinary markdown passes through untouched', () => {
  const body = 'Please preserve **this decision**.\n\n- First\n- Second';
  assert.deepEqual(prCommentBlocks(body), [{ kind: 'markdown', text: body }]);
});

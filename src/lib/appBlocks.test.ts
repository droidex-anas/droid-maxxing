import assert from 'node:assert/strict';
import test from 'node:test';

import { appFencesInMarkdown } from './appBlocks';

test('parsed app fences report the line they open on', () => {
  const source = [
    'Intro paragraph.',
    '',
    '```app',
    '<main>Complete</main>',
    '```',
    '',
    '```app',
    '<main>Still streaming',
  ].join('\n');

  assert.deepEqual(appFencesInMarkdown(source), [
    { complete: true, startLine: 3 },
    { complete: false, startLine: 7 },
  ]);
});

test('app fences inside quotes and lists report their own opening line', () => {
  const source = ['- item', '', '  > ```app', '  > <main>Quoted</main>', '  > ```'].join('\n');

  assert.deepEqual(appFencesInMarkdown(source), [{ complete: true, startLine: 3 }]);
});

test('only the fence left unterminated is reported incomplete', () => {
  const source = ['```app', '<main>One</main>', '```', '```app', '<main>Two</main>', '```'].join(
    '\n',
  );

  assert.deepEqual(
    appFencesInMarkdown(source).map((fence) => fence.complete),
    [true, true],
  );
});

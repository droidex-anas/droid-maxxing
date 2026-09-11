import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLineContains } from './commandLineMatch';

test('commandLineContains matches whole-token command sequences', async (t) => {
  await t.test(
    'matches command in node shebang path: node /usr/local/bin npm run dev contains npm run dev',
    () => {
      assert.equal(commandLineContains('node /usr/local/bin npm run dev', 'npm run dev'), true);
    },
  );

  await t.test('rejects prefix match: npm run dev:api does not contain npm run dev', () => {
    assert.equal(commandLineContains('npm run dev:api', 'npm run dev'), false);
  });

  await t.test('matches after whitespace prefix: sh -c npm run dev contains npm run dev', () => {
    assert.equal(commandLineContains('sh -c npm run dev', 'npm run dev'), true);
  });
});

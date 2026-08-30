import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAutomationTitle } from './title.js';

test('automation tools derive a usable title when the model omits one', () => {
  assert.equal(
    deriveAutomationTitle('Please scan the repository for unused node modules every Monday.'),
    'scan the repository for unused node modules every Monday',
  );
  assert.equal(deriveAutomationTitle(''), 'Scheduled task');
  assert.ok(deriveAutomationTitle('x'.repeat(200)).length <= 72);
});

test('a derived title keeps decimals and astral characters intact', () => {
  assert.equal(deriveAutomationTitle('Ship v1.5 to staging'), 'Ship v1.5 to staging');
  assert.equal(deriveAutomationTitle('Check the queue. Then report.'), 'Check the queue');

  const emoji = '🚀'.repeat(80);
  const truncated = deriveAutomationTitle(emoji);
  assert.ok(truncated.endsWith('…'));
  assert.ok(!truncated.includes('\ufffd'));
  assert.equal(Array.from(truncated).length, 70);
});

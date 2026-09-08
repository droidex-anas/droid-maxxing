import assert from 'node:assert/strict';
import test from 'node:test';
import { compactError } from './proposalCardState';
import { automationProposalIdFromText } from './toolNames';

test('proposal cards decode automation JSON and MCP text results without guessing IDs', () => {
  const result = JSON.stringify({ ok: true, proposalId: 'p1' });
  const content = [{ type: 'text', text: result }];
  for (const text of [result, JSON.stringify(content), JSON.stringify({ content })]) {
    assert.equal(automationProposalIdFromText(text), 'p1');
  }
  for (const text of [
    '{"ok":false,"proposalId":"p1"}',
    'broken {"proposalId":"p1"}',
    '{"unrelated":{"ok":true,"proposalId":"p1"}}',
  ]) {
    assert.equal(automationProposalIdFromText(text), null);
  }
  assert.equal(
    compactError(
      JSON.stringify({ content: [{ type: 'text', text: '{"ok":false,"error":"Disk full"}' }] }),
    ),
    'Disk full',
  );
  assert.equal(compactError('Connection lost'), 'Connection lost');
});

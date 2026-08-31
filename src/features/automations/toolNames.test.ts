import assert from 'node:assert/strict';
import test from 'node:test';
import {
  automationProposalIdFromText,
  automationToolBaseName,
  isAutomationProposalCall,
  parseToolResultObject,
} from './toolNames';

test('proposal tool detection accepts the SDK namespace shapes used by MCP servers', () => {
  assert.equal(automationToolBaseName('automation_propose'), 'automation_propose');
  assert.equal(
    automationToolBaseName('droidex-automations___automation_propose'),
    'automation_propose',
  );
  assert.equal(
    automationToolBaseName('mcp__droidex-automations__automation_propose'),
    'automation_propose',
  );
  assert.equal(
    automationToolBaseName('droidmaxx-browser___automation_propose'),
    'droidmaxx_browser_automation_propose',
  );
  assert.equal(
    isAutomationProposalCall({
      kind: 'tool_call',
      toolName: 'mcp__droidex-automations__automation_propose',
    }),
    true,
  );
  assert.equal(isAutomationProposalCall({ kind: 'tool_call', toolName: 'Grep' }), false);
});

test('proposal ids are recovered from plain, fenced, and wrapped tool results', () => {
  assert.equal(automationProposalIdFromText('{"ok":true,"proposalId":"proposal-a"}'), 'proposal-a');
  assert.equal(
    automationProposalIdFromText('```json\n{"ok":true,"proposalId":"proposal-b"}\n```'),
    'proposal-b',
  );
  assert.equal(
    automationProposalIdFromText('Result: {"ok":true,"proposalId":"proposal-c"}'),
    'proposal-c',
  );

  assert.equal(
    automationProposalIdFromText(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, proposalId: 'proposal-d' }) }],
      }),
    ),
    'proposal-d',
  );
});

test('tool failures resolve to the real payload instead of the MCP text envelope', () => {
  assert.deepEqual(
    parseToolResultObject(
      JSON.stringify({
        content: [{ type: 'text', text: 'Automation limit reached' }],
        isError: true,
      }),
    ),
    { error: 'Automation limit reached' },
  );

  assert.deepEqual(
    parseToolResultObject(
      JSON.stringify({
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, error: 'Unknown automation' }) },
        ],
      }),
    ),
    { ok: false, error: 'Unknown automation' },
  );

  assert.deepEqual(parseToolResultObject('{"ok":true,"proposalId":"proposal-a"}'), {
    ok: true,
    proposalId: 'proposal-a',
  });
});

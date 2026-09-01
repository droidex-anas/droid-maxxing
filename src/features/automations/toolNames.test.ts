import assert from 'node:assert/strict';
import test from 'node:test';
import { automationToolBaseName, isAutomationProposalCall } from './toolNames';

test('proposal tool detection accepts only the automations MCP namespace', () => {
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
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATION_MCP_SERVER_NAME, shouldAutoApproveAutomationTool } from './permissionPolicy.js';

test('direct mutations auto-approve only for High autonomy while delete always asks', () => {
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_create', 'medium'),
    false,
  );
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_create', 'high'),
    true,
  );
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_delete', 'high'),
    false,
  );
  assert.equal(
    shouldAutoApproveAutomationTool(AUTOMATION_MCP_SERVER_NAME, 'vendor_automation_create', 'high'),
    false,
  );
});

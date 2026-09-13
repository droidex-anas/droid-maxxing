import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_MCP_SERVER_NAME,
  automationPermissionTarget,
  shouldAttachAutomationMcp,
  shouldAutoApproveAutomationTool,
} from './permissionPolicy.js';

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

test('unattended High runs do not auto-approve automation mutations', () => {
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_create', 'high', true),
    false,
  );
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_run_now', 'high', true),
    false,
  );
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_list', 'high', true),
    true,
  );
});

test('automation MCP is not attached to run chats on create or resume', () => {
  assert.equal(shouldAttachAutomationMcp('automation:run-1:abc', false), false);
  assert.equal(shouldAttachAutomationMcp('resume:session-run', true), false);
  assert.equal(shouldAttachAutomationMcp('resume:session-run', false), true);
  assert.equal(shouldAttachAutomationMcp(undefined, false), true);
});

test('conflicting explicit and namespaced MCP server names are rejected', () => {
  const params = {
    toolUses: [
      {
        details: {
          type: 'mcp_tool',
          serverName: 'droidex-automations',
          toolName: 'untrusted___automation_create',
        },
      },
    ],
  } as never;

  assert.equal(automationPermissionTarget(params), null);
});

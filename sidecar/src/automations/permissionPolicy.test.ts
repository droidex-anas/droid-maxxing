import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestPermissionRequestParams } from '@factory/droid-sdk';
import {
  AUTOMATION_MCP_SERVER_NAME,
  automationPermissionTarget,
  automationToolDisplayTitle,
  automationToolName,
  isAutomationMutationPermission,
  normalizeMcpServerName,
  shouldAutoApproveAutomationPermission,
  shouldAutoApproveAutomationTool,
} from './permissionPolicy.js';

function request(serverName: string, toolName: string): RequestPermissionRequestParams {
  return {
    toolUses: [
      {
        details: { type: 'mcp_tool', serverName, toolName },
        toolUse: { input: {} },
      },
    ],
  } as unknown as RequestPermissionRequestParams;
}

test('proposal and list tools never interrupt the chat with an approval prompt', () => {
  assert.equal(
    shouldAutoApproveAutomationPermission(
      request('droidex-automations', 'droidex-automations___automation_propose'),
      'off',
    ),
    true,
  );
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations', 'automation_list', 'low'),
    true,
  );
});

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
});

test('permission parsing accepts SDK namespaced tool names', () => {
  assert.deepEqual(
    automationPermissionTarget(request('', 'droidex-automations___automation_run_now')),
    { serverName: 'droidex-automations', toolName: 'automation_run_now' },
  );
});

test('automation permissions use concise DROIDEX-native titles', () => {
  assert.equal(
    automationToolDisplayTitle('droidex-automations', 'automation_delete'),
    'Delete DROIDEX automation',
  );
  assert.equal(
    automationToolDisplayTitle('droidmaxx-browser', 'droidmaxx-browser___automation_propose'),
    null,
  );
  assert.equal(automationToolDisplayTitle('some-other-server', 'unrelated_tool'), null);
  assert.equal(automationToolDisplayTitle('some-other-server', 'automation_propose'), null);
  assert.equal(
    shouldAutoApproveAutomationTool('some-other-server', 'automation_propose', 'high'),
    false,
  );
});

test('server-name normalization collapses case, separators, and padding to one name', () => {
  for (const variant of [
    'droidex-automations',
    ' DROIDEX_Automations ',
    'droidex automations',
    'droidex__automations',
  ]) {
    assert.equal(normalizeMcpServerName(variant), AUTOMATION_MCP_SERVER_NAME);
    assert.equal(shouldAutoApproveAutomationTool(variant, 'automation_list', 'off'), true);
  }
  assert.equal(normalizeMcpServerName('droidex-automations-2'), 'droidex-automations-2');
  assert.equal(
    shouldAutoApproveAutomationTool('droidex-automations-2', 'automation_list', 'off'),
    false,
  );
});

test('retired server names no longer inherit automation trust', () => {
  for (const retired of ['droidmaxx-browser', 'droidmaxx_browser']) {
    assert.equal(shouldAutoApproveAutomationTool(retired, 'automation_propose', 'high'), false);
    assert.equal(shouldAutoApproveAutomationTool(retired, 'automation_create', 'high'), false);
    assert.equal(automationToolDisplayTitle(retired, 'automation_create'), null);
  }
});

test('an absent server never counts as the automation server', () => {
  assert.equal(shouldAutoApproveAutomationTool('', 'automation_propose', 'high'), false);
  assert.equal(shouldAutoApproveAutomationTool('   ', 'automation_create', 'high'), false);
  assert.equal(
    shouldAutoApproveAutomationPermission(request('', 'automation_create'), 'high'),
    false,
  );
});

test('only the canonical namespaced tool shape resolves to an automation tool', () => {
  assert.equal(automationToolName('automation_create'), 'automation_create');
  assert.equal(automationToolName('droidex-automations___automation_create'), 'automation_create');
  assert.equal(
    automationToolName('mcp__droidex-automations__automation_create'),
    'automation_create',
  );
  assert.equal(automationToolName('vendor_automation_create'), '');
  assert.equal(automationToolName('vendor_automation_wrap_automation_create'), '');
  assert.equal(automationToolName('automation_create_backup'), '');
  assert.equal(
    shouldAutoApproveAutomationTool(AUTOMATION_MCP_SERVER_NAME, 'vendor_automation_create', 'high'),
    false,
  );
});

test('malformed permission payloads are not treated as automation mutations', () => {
  const empty = { toolUses: [] } as unknown as RequestPermissionRequestParams;
  const missingDetails = {
    toolUses: [{ toolUse: { input: {} } }],
  } as unknown as RequestPermissionRequestParams;
  for (const params of [empty, missingDetails, {} as RequestPermissionRequestParams]) {
    assert.equal(automationPermissionTarget(params), null);
    assert.equal(shouldAutoApproveAutomationPermission(params, 'high'), false);
    assert.equal(isAutomationMutationPermission(params), false);
  }
});

test('mutations are distinguished from read-only automation tools', () => {
  assert.equal(
    isAutomationMutationPermission(request(AUTOMATION_MCP_SERVER_NAME, 'automation_create')),
    true,
  );
  assert.equal(
    isAutomationMutationPermission(request(AUTOMATION_MCP_SERVER_NAME, 'automation_delete')),
    true,
  );
  assert.equal(
    isAutomationMutationPermission(request(AUTOMATION_MCP_SERVER_NAME, 'automation_list')),
    false,
  );
  assert.equal(
    isAutomationMutationPermission(request(AUTOMATION_MCP_SERVER_NAME, 'automation_propose')),
    false,
  );
  assert.equal(isAutomationMutationPermission(request('other-server', 'automation_create')), false);
});

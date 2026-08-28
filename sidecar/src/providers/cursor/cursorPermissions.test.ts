import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURSOR_ACP_KIND_APPROVAL_TABLE,
  CURSOR_ACP_KIND_FALLBACK_APPROVAL_CLASS,
  CURSOR_ACP_KIND_FALLBACK_PERMISSION_KIND,
  CURSOR_AUTONOMY_TABLE,
  CURSOR_DECISION_TO_OPTION_KIND,
  approvalClassForAcpKind,
  mapApprovalDecisionToAcpResult,
  parseCursorPermissionRequest,
  permissionKindForAcpKind,
  selectAdvertisedAllowOptionId,
  shouldAutoApproveAcpKind,
} from './cursorPermissions.js';

const STANDARD_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
] as const;

test('each ACP tool kind maps to the documented approval request type', () => {
  for (const row of CURSOR_ACP_KIND_APPROVAL_TABLE) {
    assert.equal(permissionKindForAcpKind(row.acpKind), row.permissionKind, row.acpKind);
    assert.equal(approvalClassForAcpKind(row.acpKind), row.approvalClass, row.acpKind);
  }
  assert.equal(permissionKindForAcpKind('search'), CURSOR_ACP_KIND_FALLBACK_PERMISSION_KIND);
  assert.equal(approvalClassForAcpKind('search'), CURSOR_ACP_KIND_FALLBACK_APPROVAL_CLASS);
  assert.equal(approvalClassForAcpKind('think'), 'dynamic_tool');
  const parsed = parseCursorPermissionRequest({
    sessionId: 's1',
    toolCall: {
      toolCallId: 't1',
      kind: 'execute',
      title: 'npm test',
      rawInput: { command: 'npm test' },
    },
    options: STANDARD_OPTIONS,
  });
  assert.equal(parsed?.approvalClass, 'command');
  assert.equal(parsed?.permissionKind, 'exec');
  assert.equal(
    parseCursorPermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 't1', kind: 'read', title: 'src/a.ts' },
      options: STANDARD_OPTIONS,
    })?.approvalClass,
    'file_read',
  );
  assert.equal(
    parseCursorPermissionRequest({
      sessionId: 's1',
      toolCall: { toolCallId: 't1', kind: 'edit' },
      options: STANDARD_OPTIONS,
    })?.approvalClass,
    'file_change',
  );
});

test('each DROIDEX decision selects the advertised option id, never a hardcoded id', () => {
  const custom = [
    { optionId: 'yes-please', name: 'Yes', kind: 'allow_once' },
    { optionId: 'keep-going', name: 'Always', kind: 'allow_always' },
    { optionId: 'no-thanks', name: 'No', kind: 'reject_once' },
  ];
  assert.deepEqual(mapApprovalDecisionToAcpResult({ decision: 'allow_once' }, custom), {
    outcome: { outcome: 'selected', optionId: 'yes-please' },
  });
  assert.deepEqual(mapApprovalDecisionToAcpResult({ decision: 'allow_session' }, custom), {
    outcome: { outcome: 'selected', optionId: 'keep-going' },
  });
  assert.deepEqual(mapApprovalDecisionToAcpResult({ decision: 'deny' }, custom), {
    outcome: { outcome: 'selected', optionId: 'no-thanks' },
  });
  assert.deepEqual(mapApprovalDecisionToAcpResult({ decision: 'cancel' }, custom), {
    outcome: { outcome: 'cancelled' },
  });
  assert.deepEqual(
    mapApprovalDecisionToAcpResult({ decision: 'option', option: 'yes-please' }, custom),
    { outcome: { outcome: 'selected', optionId: 'yes-please' } },
  );
  for (const row of CURSOR_DECISION_TO_OPTION_KIND) {
    const result = mapApprovalDecisionToAcpResult({ decision: row.decision }, STANDARD_OPTIONS);
    assert.equal(result.outcome.outcome, 'selected');
    if (result.outcome.outcome === 'selected') {
      const matched = STANDARD_OPTIONS.find((option) => option.kind === row.optionKind);
      assert.equal(result.outcome.optionId, matched?.optionId);
    }
  }
});

test('a non-standard option set is selected from or cancelled, never invented', () => {
  const onlyAlways = [{ optionId: 'custom-always', name: 'Always', kind: 'allow_always' }];
  assert.deepEqual(mapApprovalDecisionToAcpResult({ decision: 'allow_once' }, onlyAlways), {
    outcome: { outcome: 'cancelled' },
  });
  assert.deepEqual(mapApprovalDecisionToAcpResult({ decision: 'allow_session' }, onlyAlways), {
    outcome: { outcome: 'selected', optionId: 'custom-always' },
  });
  assert.deepEqual(
    mapApprovalDecisionToAcpResult({ decision: 'option', option: 'allow_once' }, onlyAlways),
    { outcome: { outcome: 'cancelled' } },
  );
  assert.equal(selectAdvertisedAllowOptionId(onlyAlways), 'custom-always');
});

test('every autonomy table row is applied, including off never auto-approving', () => {
  const kinds = ['execute', 'read', 'search', 'fetch', 'edit', 'delete', 'move', 'think'];
  for (const row of CURSOR_AUTONOMY_TABLE) {
    for (const kind of kinds) {
      const listed = row.autoApproveAcpKinds;
      const expected = listed === 'all' || (listed as readonly string[]).includes(kind);
      assert.equal(
        shouldAutoApproveAcpKind(row.autonomy, kind),
        expected,
        `${row.autonomy} + ${kind}`,
      );
    }
  }
  assert.equal(shouldAutoApproveAcpKind('off', 'read'), false);
  assert.equal(shouldAutoApproveAcpKind('high', 'execute'), true);
});

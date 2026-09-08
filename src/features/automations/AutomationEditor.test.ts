import assert from 'node:assert/strict';
import test from 'node:test';
import { automationWorkspaceIssue, defaultAutomationDraft } from './schedule';

test('workspace validation waits for discovery and rejects a disappeared selection', () => {
  const draft = defaultAutomationDraft('/repo', 'model-a', 'high');

  assert.equal(
    automationWorkspaceIssue(draft, [], false),
    'Checking whether the selected workspace is available.',
  );
  assert.equal(automationWorkspaceIssue(draft, [{ cwd: '/repo', executionCwds: [] }], true), null);
  assert.equal(
    automationWorkspaceIssue(draft, [{ cwd: '/other', executionCwds: [] }], true),
    'repo is no longer available. Choose a workspace or select No workspace.',
  );

  draft.workspaceCwd = null;
  assert.equal(automationWorkspaceIssue(draft, [], false), null);
});

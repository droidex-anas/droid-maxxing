import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptEvent } from '../../types/bridge';
import { compactError, findProposalForCall } from './proposalCardState';
import { automationProposalIdFromText } from './toolNames';
import type { AutomationProposal } from './types';

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

test('an explicit proposal id never falls back to a different proposal', () => {
  const call: TranscriptEvent = {
    id: 'call-1',
    appSessionId: 'session-1',
    sourceSessionId: 'session-1',
    role: 'primary',
    ts: 1_000,
    kind: 'tool_call',
    toolName: 'automation_propose',
  };
  const proposal: AutomationProposal = {
    id: 'proposal-1',
    sourceAppSessionId: call.appSessionId,
    draft: {
      title: 'Daily report',
      prompt: 'Write the report.',
      workspaceCwd: '/repo',
      executionMode: 'worktree',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
      autonomy: 'low',
    },
    status: 'draft',
    missingFields: [],
    automationId: null,
    createdAt: call.ts,
    updatedAt: call.ts,
    confirmedAt: null,
  };

  assert.equal(
    findProposalForCall([proposal], call, proposal.draft, 'missing-proposal'),
    undefined,
  );
  assert.equal(findProposalForCall([proposal], call, proposal.draft, proposal.id), proposal);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactError,
  draftPreviewFromToolArgs,
  findProposalForCall,
  proposalState,
} from './proposalCardState';
import { deviceTimeZone, zonedInputParts } from './schedule';
import type { TranscriptEvent } from '../../types/bridge';
import type { AutomationProposal } from './types';

function proposal(overrides: Partial<AutomationProposal> = {}): AutomationProposal {
  return {
    id: 'prop-1',
    status: 'draft',
    createdAt: 1_000,
    updatedAt: 1_000,
    confirmedAt: null,
    automationId: null,
    sourceAppSessionId: 'session-a',
    missingFields: [],
    draft: {
      title: 'Nightly digest',
      prompt: 'Summarize the day.',
      workspaceCwd: null,
      executionMode: 'local',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: null,
      autonomy: 'low',
    },
    ...overrides,
  };
}

function toolCall(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    id: 'evt-1',
    kind: 'tool_call',
    appSessionId: 'session-a',
    ts: 1_000,
    toolName: 'automation_propose',
    ...overrides,
  } as TranscriptEvent;
}

test('a tool error outranks every other proposal state', () => {
  const state = proposalState({
    running: true,
    proposal: proposal({ status: 'confirmed' }),
    toolError: 'Timezone is unknown.',
    modelIssue: null,
  });
  assert.equal(state.kind, 'failed');
});

test('missing fields or an unusable model keep the proposal in review', () => {
  assert.equal(
    proposalState({
      running: false,
      proposal: proposal({ missingFields: ['modelId'] }),
      toolError: null,
      modelIssue: null,
    }).kind,
    'review',
  );
  assert.equal(
    proposalState({
      running: false,
      proposal: proposal(),
      toolError: null,
      modelIssue: 'Pick a reasoning effort.',
    }).kind,
    'review',
  );
  assert.equal(
    proposalState({ running: false, proposal: proposal(), toolError: null, modelIssue: null }).kind,
    'ready',
  );
});

test('a card without its proposal yet still reports preparing', () => {
  const state = proposalState({
    running: false,
    proposal: undefined,
    toolError: null,
    modelIssue: null,
  });
  assert.equal(state.kind, 'preparing');
});

test('a replayed call matches only proposals from its own session and time window', () => {
  const mine = proposal({ id: 'mine', createdAt: 1_000 });
  const otherSession = proposal({ id: 'other', sourceAppSessionId: 'session-b' });
  const tooOld = proposal({ id: 'old', createdAt: 1_000 - 6 * 60 * 1_000 });

  const match = findProposalForCall([otherSession, tooOld, mine], toolCall(), null);
  assert.equal(match?.id, 'mine');
  assert.equal(findProposalForCall([otherSession, tooOld], toolCall(), null), undefined);
});

test('a matching prompt wins over creation order', () => {
  const first = proposal({ id: 'first', draft: { ...proposal().draft, prompt: 'Something else' } });
  const second = proposal({ id: 'second' });
  const fallback = draftPreviewFromToolArgs({
    prompt: 'Summarize the day.',
    schedule: { kind: 'daily', time: '09:00' },
  });

  assert.equal(findProposalForCall([first, second], toolCall(), fallback)?.id, 'second');
});

test('the tool-argument preview fills a title and rejects malformed arguments', () => {
  const preview = draftPreviewFromToolArgs({
    prompt: 'Post the standup summary. Then close the thread.',
    schedule: { kind: 'daily', time: '09:00' },
    reasoningEffort: 'nonsense',
  });
  assert.equal(preview?.title, 'Post the standup summary');
  assert.equal(preview?.reasoningEffort, null);
  assert.equal(preview?.autonomy, 'low');
  assert.equal(preview?.executionMode, 'local');

  assert.equal(draftPreviewFromToolArgs({ prompt: 'No schedule' }), null);
  assert.equal(draftPreviewFromToolArgs([{ prompt: 'x' }]), null);
  assert.equal(draftPreviewFromToolArgs(null), null);
});

test('a model-supplied timezone the platform cannot format falls back to the device zone', () => {
  const preview = draftPreviewFromToolArgs({
    prompt: 'Run the nightly digest.',
    schedule: { kind: 'daily', time: '09:00' },
    timezone: 'PDT',
  });
  assert.equal(preview?.timezone, deviceTimeZone());
  assert.doesNotThrow(() => zonedInputParts(Date.now(), preview?.timezone ?? ''));
});

test('a schedule the editor could not format is refused instead of previewed', () => {
  const unusable: unknown[] = [
    { kind: 'once', runAt: Number.NaN },
    { kind: 'once', runAt: 1e21 },
    { kind: 'once', runAt: '2025-01-01' },
    { kind: 'daily', time: '9am' },
    { kind: 'daily', hour: 9, minute: 0 },
    { kind: 'weekly', weekday: 9, time: '09:00' },
    { kind: 'hourly', minute: 75 },
    { kind: 'cron', expression: 'every friday' },
    { kind: 'monthly', day: 1 },
  ];
  for (const schedule of unusable) {
    assert.equal(
      draftPreviewFromToolArgs({ prompt: 'Run something.', schedule }),
      null,
      `expected ${JSON.stringify(schedule)} to be refused`,
    );
  }
  assert.deepEqual(
    draftPreviewFromToolArgs({
      prompt: 'Run something.',
      schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
    })?.schedule,
    { kind: 'cron', expression: '0 9 * * 1-5' },
  );
});

test('tool errors are unwrapped from the result payload and bounded', () => {
  assert.equal(compactError(JSON.stringify({ error: 'Unknown timezone.' })), 'Unknown timezone.');
  assert.equal(compactError(undefined), 'DROIDEX could not prepare this automation.');
  const long = compactError('x'.repeat(400));
  assert.equal(long.length, 218);
  assert.ok(long.endsWith('…'));
  const longUnwrapped = compactError(JSON.stringify({ error: 'y'.repeat(400) }));
  assert.equal(longUnwrapped.length, 218);
  assert.ok(longUnwrapped.endsWith('…'));
});

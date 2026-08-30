import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelInfo } from '../../types/bridge';
import {
  convertOnceRunAt,
  cronExpressionIssue,
  defaultAutomationDraft,
  epochFromZonedInput,
  formatAutomationRunStatus,
  formatSchedule,
  resolveAutomationModelDefaults,
  validateAutomationDraft,
  zonedInputParts,
} from './schedule';

const MODELS: ModelInfo[] = [
  {
    id: 'model-a',
    displayName: 'Model A',
    isCustom: false,
    isDefault: true,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
];

test('automation defaults store an actual model and reasoning selection', () => {
  const draft = defaultAutomationDraft('/repo', 'model-a', 'high');
  assert.equal(draft.workspaceCwd, '/repo');
  assert.equal(draft.executionMode, 'worktree');
  assert.equal(draft.modelId, 'model-a');
  assert.equal(draft.reasoningEffort, 'high');
  assert.ok(draft.timezone.length > 0);
});

test('model defaults come from the user-visible model catalog', () => {
  const selection = resolveAutomationModelDefaults(MODELS, null, null);
  assert.deepEqual(selection, { modelId: 'model-a', reasoningEffort: 'high' });
});

test('zoned date-time conversion round trips a normal local time', () => {
  const input = { year: 2026, month: 8, day: 20, hour: 9, minute: 30 };
  const epoch = epochFromZonedInput(input, 'Asia/Kolkata');
  assert.deepEqual(zonedInputParts(epoch, 'Asia/Kolkata'), input);
});

test('converting a one-time run between timezones keeps the local wall time', () => {
  const input = { year: 2026, month: 8, day: 20, hour: 9, minute: 30 };
  const epoch = epochFromZonedInput(input, 'Asia/Kolkata');
  const converted = convertOnceRunAt(epoch, 'Asia/Kolkata', 'America/New_York');
  assert.deepEqual(zonedInputParts(converted, 'America/New_York'), input);
  assert.notEqual(converted, epoch);
});

test('an ambiguous local time resolves to its first occurrence', () => {
  // 01:30 happens twice in New York on 2 November 2025 (EDT then EST).
  const input = { year: 2025, month: 11, day: 2, hour: 1, minute: 30 };
  const epoch = epochFromZonedInput(input, 'America/New_York');
  assert.deepEqual(zonedInputParts(epoch, 'America/New_York'), input);
  assert.equal(new Date(epoch).toISOString(), '2025-11-02T05:30:00.000Z');
});

test('a local time inside a spring-forward gap resolves after the gap', () => {
  // 02:30 never happens in New York on 9 March 2025; clocks jump 02:00 to 03:00.
  const epoch = epochFromZonedInput(
    { year: 2025, month: 3, day: 9, hour: 2, minute: 30 },
    'America/New_York',
  );
  assert.deepEqual(zonedInputParts(epoch, 'America/New_York'), {
    year: 2025,
    month: 3,
    day: 9,
    hour: 3,
    minute: 30,
  });
});

test('recurring times are shown as their own wall clock, not the device zone', () => {
  // Whether the host renders 12- or 24-hour clocks is a locale choice, so the
  // expectation is built for the host locale too. What must hold everywhere is
  // that the stated wall clock survives: it is never shifted into another zone.
  const wallClock = (hour: number, minute: number) =>
    new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(Date.UTC(1970, 0, 1, hour, minute));

  const earlyMorning = formatSchedule({ kind: 'daily', time: '00:30' }, 'Asia/Kolkata');
  const lateEvening = formatSchedule({ kind: 'daily', time: '23:45' }, 'Asia/Kolkata');
  assert.ok(
    earlyMorning.includes(wallClock(0, 30)),
    `${earlyMorning} should show ${wallClock(0, 30)}`,
  );
  assert.ok(
    lateEvening.includes(wallClock(23, 45)),
    `${lateEvening} should show ${wallClock(23, 45)}`,
  );
});

test('cron validation mirrors the scheduler grammar', () => {
  assert.equal(cronExpressionIssue('0 0 * * *'), null);
  assert.equal(cronExpressionIssue('*/15 9-17 1,15 */2 1-5'), null);
  assert.equal(cronExpressionIssue('  0   9 * * 7 '), null);

  assert.equal(cronExpressionIssue('a b c d e'), '“a” is not a valid cron minute field.');
  assert.equal(cronExpressionIssue('0 0 * * ,1'), '“,1” is not a valid cron weekday field.');
  assert.equal(cronExpressionIssue('0 0 * *'), 'Use a five-field cron expression.');
  assert.equal(cronExpressionIssue('60 0 * * *'), '“60” is not a valid cron minute field.');
  assert.equal(cronExpressionIssue('0 0 0 * *'), '“0” is not a valid cron day of month field.');
  assert.equal(cronExpressionIssue('0 0 * * 1-0'), '“1-0” is not a valid cron weekday field.');
  assert.equal(cronExpressionIssue('*/0 0 * * *'), '“*/0” is not a valid cron minute field.');
});

test('draft validation rejects a cron expression the scheduler would refuse', () => {
  const draft = defaultAutomationDraft(null, 'model-a', 'medium');
  draft.title = 'Custom';
  draft.prompt = 'Run something';
  draft.schedule = { kind: 'cron', expression: 'a b c d e' };
  assert.match(validateAutomationDraft(draft, MODELS) ?? '', /not a valid cron minute field/);

  draft.schedule = { kind: 'cron', expression: '0 0 * * ,1' };
  assert.match(validateAutomationDraft(draft, MODELS) ?? '', /not a valid cron weekday field/);

  draft.schedule = { kind: 'cron', expression: '*/15 9-17 * * 1-5' };
  assert.equal(validateAutomationDraft(draft, MODELS), null);
});

test('draft validation rejects past one-time schedules after model selection', () => {
  const draft = defaultAutomationDraft(null, 'model-a', 'medium');
  draft.title = 'Past';
  draft.prompt = 'Run something';
  draft.schedule = { kind: 'once', runAt: Date.now() - 1 };
  assert.equal(validateAutomationDraft(draft, MODELS), 'Choose a future date and time.');
});

test('draft validation allows catalog-missing custom models and rejects unsupported reasoning', () => {
  const draft = defaultAutomationDraft(null, 'custom:byok', 'medium');
  draft.title = 'Catalog validation';
  draft.prompt = 'Run something';
  assert.equal(validateAutomationDraft(draft, MODELS), null);

  draft.modelId = 'model-a';
  draft.reasoningEffort = 'xhigh';
  assert.match(validateAutomationDraft(draft, MODELS) ?? '', /does not support xhigh reasoning/i);
});

test('running status includes live elapsed time', () => {
  assert.equal(
    formatAutomationRunStatus(
      {
        id: 'run',
        automationId: 'automation',
        automation: {
          id: 'automation',
          title: 'Task',
          prompt: 'Run',
          workspaceCwd: null,
          executionMode: 'local',
          timezone: 'UTC',
          modelId: 'model-a',
          reasoningEffort: 'medium',
        },
        scheduledAt: 0,
        requestedAt: 0,
        trigger: 'manual',
        status: 'running',
        startedAt: 1_000,
        finishedAt: null,
        clientRef: 'ref',
        appSessionId: 'session',
        resolvedCwd: null,
        error: null,
        effectiveModelId: 'model-a',
        effectiveReasoningEffort: 'medium',
        selectionVerified: true,
      },
      46_000,
    ),
    'Running · 45s',
  );
});

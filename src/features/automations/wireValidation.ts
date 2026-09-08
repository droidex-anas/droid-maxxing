import { normalizeAutonomy } from '../../lib/autonomy';
import { isReasoningEffort } from '../../lib/reasoningEffort';
import { cronExpressionIssue, isTimeZone, validTime } from './schedule';
import type {
  Automation,
  AutomationDraft,
  AutomationProposal,
  AutomationRun,
  AutomationSchedule,
  AutomationSessionOrigin,
  AutomationSnapshot,
} from './types';

const RUN_STATUSES = new Set(['queued', 'starting', 'running', 'completed', 'failed']);
export function isAutomationSnapshot(value: unknown): value is AutomationSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.automations) &&
    value.automations.every(isAutomation) &&
    Array.isArray(value.runs) &&
    value.runs.every(isAutomationRun) &&
    Array.isArray(value.proposals) &&
    value.proposals.every(isAutomationProposal) &&
    isSessionOriginMap(value.sessionOrigins) &&
    nonNegativeSafeInteger(value.queuedRunCount) &&
    nonNegativeSafeInteger(value.activeRunCount) &&
    isRecord(value.scheduler) &&
    typeof value.scheduler.ready === 'boolean' &&
    nullableFiniteNumber(value.scheduler.nextWakeAt) &&
    nullableNonEmptyString(value.scheduler.activeRunId)
  );
}

function isAutomation(value: unknown): value is Automation {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    isAutomationDraft(value) &&
    nullableFiniteNumber(value.nextRunAt) &&
    nullableFiniteNumber(value.lastRunAt) &&
    (value.lastRunStatus === null || stringMember(value.lastRunStatus, RUN_STATUSES)) &&
    nullableString(value.lastRunError) &&
    nullableFiniteNumber(value.lastRunDurationMs) &&
    nullableNonEmptyString(value.lastAppSessionId) &&
    nullableFiniteNumber(value.completedAt) &&
    finiteNumber(value.createdAt) &&
    finiteNumber(value.updatedAt)
  );
}

function isAutomationDraft(value: unknown): value is AutomationDraft {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.prompt === 'string' &&
    nullableString(value.workspaceCwd) &&
    (value.executionMode === 'local' || value.executionMode === 'worktree') &&
    typeof value.enabled === 'boolean' &&
    isAutomationSchedule(value.schedule) &&
    typeof value.timezone === 'string' &&
    isTimeZone(value.timezone) &&
    nullableString(value.modelId) &&
    nullableReasoningEffort(value.reasoningEffort) &&
    normalizeAutonomy(value.autonomy) !== undefined
  );
}

function isAutomationSchedule(value: unknown): value is AutomationSchedule {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'once':
      return finiteNumber(value.runAt);
    case 'hourly':
      return nonNegativeSafeInteger(value.minute) && value.minute <= 59;
    case 'daily':
    case 'weekdays':
      return typeof value.time === 'string' && validTime(value.time);
    case 'weekly':
      return (
        nonNegativeSafeInteger(value.weekday) &&
        value.weekday <= 6 &&
        typeof value.time === 'string' &&
        validTime(value.time)
      );
    case 'cron':
      return typeof value.expression === 'string' && cronExpressionIssue(value.expression) === null;
    default:
      return false;
  }
}

function isAutomationRun(value: unknown): value is AutomationRun {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.automationId) &&
    isRunSnapshot(value.automation) &&
    finiteNumber(value.scheduledAt) &&
    finiteNumber(value.requestedAt) &&
    (value.trigger === 'schedule' || value.trigger === 'manual') &&
    stringMember(value.status, RUN_STATUSES) &&
    nullableFiniteNumber(value.startedAt) &&
    nullableFiniteNumber(value.finishedAt) &&
    nullableString(value.clientRef) &&
    nullableNonEmptyString(value.appSessionId) &&
    nullableString(value.resolvedCwd) &&
    nullableString(value.error) &&
    nullableString(value.effectiveModelId) &&
    nullableReasoningEffort(value.effectiveReasoningEffort) &&
    (value.selectionVerified === null || typeof value.selectionVerified === 'boolean')
  );
}

function isRunSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.title === 'string' &&
    typeof value.prompt === 'string' &&
    nullableString(value.workspaceCwd) &&
    (value.executionMode === 'local' || value.executionMode === 'worktree') &&
    typeof value.timezone === 'string' &&
    isTimeZone(value.timezone) &&
    nullableString(value.modelId) &&
    nullableReasoningEffort(value.reasoningEffort) &&
    normalizeAutonomy(value.autonomy) !== undefined
  );
}

function isAutomationProposal(value: unknown): value is AutomationProposal {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.sourceAppSessionId) &&
    isAutomationDraft(value.draft) &&
    (value.status === 'draft' || value.status === 'confirmed') &&
    Array.isArray(value.missingFields) &&
    value.missingFields.every((field) => field === 'modelId' || field === 'reasoningEffort') &&
    nullableNonEmptyString(value.automationId) &&
    finiteNumber(value.createdAt) &&
    finiteNumber(value.updatedAt) &&
    nullableFiniteNumber(value.confirmedAt)
  );
}

function isSessionOriginMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isAutomationSessionOrigin);
}

function isAutomationSessionOrigin(value: unknown): value is AutomationSessionOrigin {
  return (
    isRecord(value) &&
    nonEmptyString(value.automationId) &&
    typeof value.automationTitle === 'string' &&
    nonEmptyString(value.runId) &&
    (value.trigger === 'schedule' || value.trigger === 'manual')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stringMember(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function nullableReasoningEffort(value: unknown): boolean {
  return value === null || isReasoningEffort(value);
}

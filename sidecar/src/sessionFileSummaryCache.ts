import type { BridgeFeature, SessionSummary } from './protocol.js';
import type { ReasoningEffort } from './protocol.js';
import { objectValue, stringValue } from './values.js';

interface PersistedSessionFileSummary {
  cacheVersion: 1;
  summary: SessionSummary;
}

const SESSION_FILE_SUMMARY_CACHE_VERSION = 1;

export const SESSION_FILE_REASONING_EFFORTS: Record<ReasoningEffort, true> = {
  off: true,
  none: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  dynamic: true,
};

export function parseCachedSessionSummary(raw: unknown): SessionSummary | null | undefined {
  if (raw === null) return null;
  const text = stringValue(raw);
  if (text === undefined) return undefined;
  try {
    const cached = objectValue(JSON.parse(text));
    if (!cached) return undefined;
    const { cacheVersion, summary } = cached;
    if (cacheVersion !== SESSION_FILE_SUMMARY_CACHE_VERSION || !isSessionSummary(summary))
      return undefined;
    return summary;
  } catch {
    return undefined;
  }
}

export function serializeCachedSessionSummary(summary: SessionSummary | null): string | null {
  if (summary === null) return null;
  const cached: PersistedSessionFileSummary = {
    cacheVersion: SESSION_FILE_SUMMARY_CACHE_VERSION,
    summary,
  };
  return JSON.stringify(cached);
}

function isSessionSummary(value: unknown): value is SessionSummary {
  const summary = objectValue(value);
  if (!summary) return false;
  return hasRequiredSummaryFields(summary) && hasOptionalSummaryFields(summary);
}

function hasRequiredSummaryFields(summary: Record<string, unknown>): boolean {
  const { sessionPurpose, interactionMode, role, autonomy, phase, features } = summary;
  return (
    strings(summary, ['appSessionId', 'title', 'goal', 'cwd']) &&
    oneOf(sessionPurpose, ['chat', 'design', 'mission-control']) &&
    oneOf(interactionMode, ['auto', 'spec', 'agi']) &&
    oneOf(role, ['primary', 'user']) &&
    oneOf(autonomy, ['off', 'low', 'medium', 'high']) &&
    oneOf(phase, [
      'intake',
      'planning',
      'awaiting_plan_approval',
      'awaiting_run_start',
      'initializing',
      'running',
      'orchestrator_turn',
      'paused',
      'completed',
      'failed',
    ]) &&
    finiteNumbers(summary, ['tokensIn', 'tokensOut', 'contextTokens', 'createdAt', 'updatedAt']) &&
    Array.isArray(features) &&
    features.every(isBridgeFeature)
  );
}

function hasOptionalSummaryFields(summary: Record<string, unknown>): boolean {
  const { streaming, compactedFromProviderSessionIds } = summary;
  return (
    optionalString(summary, [
      'providerSessionId',
      'missionId',
      'modelId',
      'compactionModel',
      'workerModelId',
      'validatorModelId',
      'proposal',
      'contextUpdatedAt',
    ]) &&
    optionalRecordKeyOf(summary, 'reasoningEffort', SESSION_FILE_REASONING_EFFORTS) &&
    optionalRecordKeyOf(summary, 'workerReasoningEffort', SESSION_FILE_REASONING_EFFORTS) &&
    optionalRecordKeyOf(summary, 'validatorReasoningEffort', SESSION_FILE_REASONING_EFFORTS) &&
    optionalRecordOneOf(summary, 'contextAccuracy', ['exact', 'estimated']) &&
    optionalRecordOneOf(summary, 'workspaceKind', ['folder', 'none']) &&
    optionalFiniteNumber(summary, [
      'queuedSends',
      'contextRemainingTokens',
      'maxContextTokens',
      'compactionTokenLimit',
      'autoCompactions',
    ]) &&
    (streaming === undefined || typeof streaming === 'boolean') &&
    (compactedFromProviderSessionIds === undefined || stringArray(compactedFromProviderSessionIds))
  );
}

function optionalRecordOneOf(
  value: Record<string, unknown>,
  key: string,
  choices: readonly string[],
): boolean {
  return optionalOneOf(value[key], choices);
}

function isBridgeFeature(value: unknown): value is BridgeFeature {
  const feature = objectValue(value);
  if (!feature) return false;
  const { status, preconditions, expectedBehavior, verificationSteps, fulfills, milestone } =
    feature;
  return (
    strings(feature, ['id', 'description', 'skillName']) &&
    oneOf(status, ['pending', 'in_progress', 'completed', 'cancelled']) &&
    stringArray(preconditions) &&
    stringArray(expectedBehavior) &&
    stringArray(verificationSteps) &&
    (fulfills === undefined || stringArray(fulfills)) &&
    (milestone === undefined || typeof milestone === 'string')
  );
}

function strings(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof record[key] === 'string');
}

function finiteNumbers(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

function optionalString(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => record[key] === undefined || typeof record[key] === 'string');
}

function optionalFiniteNumber(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(
    (key) =>
      record[key] === undefined ||
      (typeof record[key] === 'number' && Number.isFinite(record[key])),
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

function optionalOneOf(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || oneOf(value, allowed);
}

function optionalRecordKeyOf<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: Record<T, true>,
): boolean {
  const value = record[key];
  return value === undefined || (typeof value === 'string' && value in allowed);
}

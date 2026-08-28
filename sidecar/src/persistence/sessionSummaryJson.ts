import { z } from 'zod';

import type { BridgeFeature, SessionPhase, SessionSummary } from '../protocol.js';
import { parseProviderError, type ProviderError } from '../providers/providerErrors.js';
import {
  droidMissionConfigurationSchema,
  providerInstanceIdSchema,
  sessionConfigurationSchema,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from '../providers/providerIdentity.js';
import { numberValue, stringValue } from '../values.js';
import { sessionWebUrlFor } from './sessionWebUrl.js';

export const SUMMARY_JSON_KEYS = [
  'missionId',
  'sessionPurpose',
  'role',
  'title',
  'goal',
  'cwd',
  'workspaceKind',
  'configuration',
  'droidMissionConfiguration',
  'compactionModel',
  'phase',
  'streaming',
  'interruptReason',
  'queuedSends',
  'proposal',
  'features',
  'tokensIn',
  'tokensOut',
  'contextTokens',
  'contextRemainingTokens',
  'contextAccuracy',
  'contextUpdatedAt',
  'maxContextTokens',
  'compactionTokenLimit',
  'autoCompactions',
] as const;

export type SummaryJsonKey = (typeof SUMMARY_JSON_KEYS)[number];

const SUMMARY_JSON_KEY_SET = new Set<string>(SUMMARY_JSON_KEYS);

const SESSION_PHASES = [
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
] as const satisfies readonly SessionPhase[];

const featureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
    skillName: z.string(),
    preconditions: z.array(z.string()),
    expectedBehavior: z.array(z.string()),
    verificationSteps: z.array(z.string()),
    fulfills: z.array(z.string()).optional(),
    milestone: z.string().optional(),
  })
  .strict();

const summaryJsonSchema = z
  .object({
    missionId: z.string().min(1).optional(),
    sessionPurpose: z.enum(['chat', 'design', 'mission-control']),
    role: z.enum(['primary', 'user']),
    title: z.string(),
    goal: z.string(),
    cwd: z.string(),
    workspaceKind: z.enum(['folder', 'none']).optional(),
    configuration: sessionConfigurationSchema,
    droidMissionConfiguration: droidMissionConfigurationSchema.optional(),
    compactionModel: z.string().min(1).optional(),
    phase: z.enum(SESSION_PHASES),
    streaming: z.boolean().optional(),
    interruptReason: z.string().min(1).optional(),
    queuedSends: z.number().int().nonnegative().optional(),
    proposal: z.string().optional(),
    features: z.array(featureSchema),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    contextTokens: z.number().int().nonnegative(),
    contextRemainingTokens: z.number().int().nonnegative().optional(),
    contextAccuracy: z.enum(['exact', 'estimated']).optional(),
    contextUpdatedAt: z.string().min(1).optional(),
    maxContextTokens: z.number().int().nonnegative().optional(),
    compactionTokenLimit: z.number().int().nonnegative().optional(),
    autoCompactions: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SummaryJson = z.infer<typeof summaryJsonSchema>;

export function encodeSummaryJson(summary: SessionSummary): string {
  const encoded: Record<string, unknown> = {
    sessionPurpose: summary.sessionPurpose,
    role: summary.role,
    title: summary.title,
    goal: summary.goal,
    cwd: summary.cwd,
    configuration: summary.configuration,
    phase: summary.phase,
    features: summary.features,
    tokensIn: summary.tokensIn,
    tokensOut: summary.tokensOut,
    contextTokens: summary.contextTokens,
  };
  if (summary.missionId !== undefined) encoded.missionId = summary.missionId;
  if (summary.workspaceKind !== undefined) encoded.workspaceKind = summary.workspaceKind;
  if (summary.droidMissionConfiguration !== undefined) {
    encoded.droidMissionConfiguration = summary.droidMissionConfiguration;
  }
  if (summary.compactionModel !== undefined) encoded.compactionModel = summary.compactionModel;
  if (summary.streaming !== undefined) encoded.streaming = summary.streaming;
  if (summary.interruptReason !== undefined) encoded.interruptReason = summary.interruptReason;
  if (summary.queuedSends !== undefined) encoded.queuedSends = summary.queuedSends;
  if (summary.proposal !== undefined) encoded.proposal = summary.proposal;
  if (summary.contextRemainingTokens !== undefined) {
    encoded.contextRemainingTokens = summary.contextRemainingTokens;
  }
  if (summary.contextAccuracy !== undefined) encoded.contextAccuracy = summary.contextAccuracy;
  if (summary.contextUpdatedAt !== undefined) encoded.contextUpdatedAt = summary.contextUpdatedAt;
  if (summary.maxContextTokens !== undefined) encoded.maxContextTokens = summary.maxContextTokens;
  if (summary.compactionTokenLimit !== undefined) {
    encoded.compactionTokenLimit = summary.compactionTokenLimit;
  }
  if (summary.autoCompactions !== undefined) encoded.autoCompactions = summary.autoCompactions;
  return JSON.stringify(encoded);
}

export function decodeSummaryJson(
  raw: string,
  providerInstanceId: ProviderInstanceId,
): SummaryJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('summary_json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('summary_json must be a JSON object');
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!SUMMARY_JSON_KEY_SET.has(key)) {
      throw new Error(`summary_json has unknown key ${key}`);
    }
  }
  const summary = summaryJsonSchema.parse(parsed);
  if (summary.configuration.providerSelection.providerInstanceId !== providerInstanceId) {
    throw new Error(
      'summary_json configuration instance does not match the provider-instance column',
    );
  }
  return summary;
}

export function projectPublicSummary(input: {
  appSessionId: string;
  createdAt: number;
  updatedAt: number;
  json: SummaryJson;
  binding: { providerDriverKind: ProviderDriverKind; providerSessionId?: string };
}): SessionSummary {
  const summary: SessionSummary = {
    appSessionId: input.appSessionId,
    sessionPurpose: input.json.sessionPurpose,
    role: input.json.role,
    title: input.json.title,
    goal: input.json.goal,
    cwd: input.json.cwd,
    configuration: input.json.configuration,
    phase: input.json.phase,
    features: input.json.features.map(copyFeature),
    tokensIn: input.json.tokensIn,
    tokensOut: input.json.tokensOut,
    contextTokens: input.json.contextTokens,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  if (input.json.missionId !== undefined) summary.missionId = input.json.missionId;
  if (input.json.workspaceKind !== undefined) summary.workspaceKind = input.json.workspaceKind;
  if (input.json.droidMissionConfiguration !== undefined) {
    summary.droidMissionConfiguration = input.json.droidMissionConfiguration;
  }
  if (input.json.compactionModel !== undefined)
    summary.compactionModel = input.json.compactionModel;
  if (input.json.streaming !== undefined) summary.streaming = input.json.streaming;
  if (input.json.interruptReason !== undefined)
    summary.interruptReason = input.json.interruptReason;
  if (input.json.queuedSends !== undefined) summary.queuedSends = input.json.queuedSends;
  if (input.json.proposal !== undefined) summary.proposal = input.json.proposal;
  if (input.json.contextRemainingTokens !== undefined) {
    summary.contextRemainingTokens = input.json.contextRemainingTokens;
  }
  if (input.json.contextAccuracy !== undefined)
    summary.contextAccuracy = input.json.contextAccuracy;
  if (input.json.contextUpdatedAt !== undefined)
    summary.contextUpdatedAt = input.json.contextUpdatedAt;
  if (input.json.maxContextTokens !== undefined)
    summary.maxContextTokens = input.json.maxContextTokens;
  if (input.json.compactionTokenLimit !== undefined) {
    summary.compactionTokenLimit = input.json.compactionTokenLimit;
  }
  if (input.json.autoCompactions !== undefined)
    summary.autoCompactions = input.json.autoCompactions;
  const sessionWebUrl = sessionWebUrlFor(input.binding);
  if (sessionWebUrl !== undefined) summary.sessionWebUrl = sessionWebUrl;
  return summary;
}

export function mergeSummaryJson(current: SummaryJson, patch: Partial<SummaryJson>): SummaryJson {
  const next: SummaryJson = {
    ...current,
    ...patch,
    ...(patch.features ? { features: patch.features.map(copyFeature) } : {}),
    ...(patch.configuration ? { configuration: patch.configuration } : {}),
  };
  return summaryJsonSchema.parse(next);
}

export function encodeResumeState(resumeState: unknown): string | null {
  if (resumeState === undefined) return null;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(resumeState);
  } catch {
    throw new Error('resume state is not valid JSON');
  }
  if (encoded === undefined) throw new Error('resume state is not valid JSON');
  return encoded;
}

export function decodeResumeState(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('resume_state_json is not valid JSON');
  }
}

export function encodePreviousProviderSessionIds(ids: readonly string[]): string {
  return JSON.stringify([...ids]);
}

export function decodePreviousProviderSessionIds(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('previous_provider_session_ids_json is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('previous_provider_session_ids_json must be a JSON array of nonempty strings');
  }
  return parsed;
}

export function failureFromColumns(row: {
  failure_code: unknown;
  failure_message: unknown;
  failure_recovery_action: unknown;
  provider_instance_id: unknown;
}): ProviderError {
  return parseProviderError({
    code: row.failure_code,
    providerInstanceId: providerInstanceIdSchema.parse(row.provider_instance_id),
    message: row.failure_message,
    recoveryAction: row.failure_recovery_action,
  });
}

export function requireNonnegativeInteger(value: unknown, label: string): number {
  const number = numberValue(value);
  if (number === undefined || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return number;
}

export function requireText(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${label} must be a nonempty string`);
  return text;
}

function copyFeature(feature: BridgeFeature): BridgeFeature {
  return {
    ...feature,
    preconditions: [...feature.preconditions],
    expectedBehavior: [...feature.expectedBehavior],
    verificationSteps: [...feature.verificationSteps],
    ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
  };
}

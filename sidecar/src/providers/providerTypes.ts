import { z } from 'zod';

import type {
  Autonomy,
  BrowserTranscriptReference,
  PermissionKind,
  ReasoningEffort,
  SessionInteractionMode,
} from '../protocol.js';
import { parseProviderError, type ProviderError } from './providerErrors.js';
import {
  autonomySchema,
  parseSessionConfiguration,
  parseSessionTarget,
  providerDriverKindForInstance,
  sessionInteractionModeSchema,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SessionConfiguration,
  type SessionTarget,
} from './providerIdentity.js';
import type { ShutdownDeadline } from './shutdownDeadline.js';
import type { ProviderEventSink } from './providerEvents.js';

export interface ProviderDefinition {
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  displayName: string;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: readonly ReasoningEffort[];
  serviceTiers: readonly string[];
}

export interface ProviderCapabilities {
  modes: readonly SessionInteractionMode[];
  autonomyLevels: readonly Autonomy[];
  modelChange: 'before_turn' | 'idle_only' | 'unsupported';
  resume: boolean;
  steer: boolean;
  interrupt: boolean;
  approvals: boolean;
  questions: boolean;
  planReview: boolean;
  context: boolean;
  compaction: boolean;
  skills: boolean;
  slashCommands: boolean;
  mcpUse: boolean;
  mcpManagement: boolean;
  rewind: boolean;
  fork: boolean;
  observationalTasks: boolean;
  addressableChildren: boolean;
  missionControl: boolean;
  browser: boolean;
  usageReporting: boolean;
  reasoningStream: boolean;
}

export const PROVIDER_MODEL_CHANGE_MODES = [
  'before_turn',
  'idle_only',
  'unsupported',
] as const satisfies readonly ProviderCapabilities['modelChange'][];

const providerModelChangeSchema = z.enum(PROVIDER_MODEL_CHANGE_MODES);

const providerCapabilityFields = {
  modes: z.array(sessionInteractionModeSchema),
  autonomyLevels: z.array(autonomySchema),
  modelChange: providerModelChangeSchema,
  resume: z.boolean(),
  steer: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  planReview: z.boolean(),
  context: z.boolean(),
  compaction: z.boolean(),
  skills: z.boolean(),
  slashCommands: z.boolean(),
  mcpUse: z.boolean(),
  mcpManagement: z.boolean(),
  rewind: z.boolean(),
  fork: z.boolean(),
  observationalTasks: z.boolean(),
  addressableChildren: z.boolean(),
  missionControl: z.boolean(),
  browser: z.boolean(),
  usageReporting: z.boolean(),
  reasoningStream: z.boolean(),
} satisfies { [K in keyof ProviderCapabilities]: z.ZodType<ProviderCapabilities[K]> };

export const PROVIDER_CAPABILITY_KEYS = [
  'modes',
  'autonomyLevels',
  'modelChange',
  'resume',
  'steer',
  'interrupt',
  'approvals',
  'questions',
  'planReview',
  'context',
  'compaction',
  'skills',
  'slashCommands',
  'mcpUse',
  'mcpManagement',
  'rewind',
  'fork',
  'observationalTasks',
  'addressableChildren',
  'missionControl',
  'browser',
  'usageReporting',
  'reasoningStream',
] as const satisfies readonly (keyof ProviderCapabilities)[];

type MissingCapabilityKey = Exclude<
  keyof ProviderCapabilities,
  (typeof PROVIDER_CAPABILITY_KEYS)[number]
>;
type ExtraCapabilityKey = Exclude<
  (typeof PROVIDER_CAPABILITY_KEYS)[number],
  keyof ProviderCapabilities
>;
const _capabilityKeysExhaustive: [MissingCapabilityKey] extends [never]
  ? [ExtraCapabilityKey] extends [never]
    ? true
    : never
  : never = true;
void _capabilityKeysExhaustive;

export const providerCapabilitiesSchema = z.object(providerCapabilityFields).strict();

export function parseProviderCapabilities(value: unknown): ProviderCapabilities {
  return providerCapabilitiesSchema.parse(value);
}

export function defineProviderCapabilities(
  capabilities: ProviderCapabilities,
): ProviderCapabilities {
  return parseProviderCapabilities(capabilities);
}

export interface ProviderPrompt {
  text: string;
  skills: readonly string[];
  files: readonly string[];
  browserRefs: readonly BrowserTranscriptReference[];
}

export interface ProviderApprovalRequest {
  requestId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  kind: PermissionKind;
  title: string;
  detail: string;
  plan?: string;
  options?: readonly string[];
}

export type ProviderApprovalDecision =
  | { decision: 'allow_once' | 'allow_session' | 'deny' | 'cancel' }
  | { decision: 'option'; option: string };

export interface ProviderQuestionRequest {
  requestId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  questions: readonly {
    id: string;
    prompt: string;
    options: readonly string[];
    multiSelect: boolean;
  }[];
}

export type ProviderQuestionAnswer =
  | { status: 'answered'; answers: Readonly<Record<string, readonly string[]>> }
  | { status: 'cancelled' };

export interface ProviderPlanReviewRequest {
  requestId: string;
  target: SessionTarget;
  runtimeGeneration: number;
  plan: string;
}

export type ProviderPlanReviewDecision =
  | { decision: 'implement' }
  | { decision: 'iterate'; feedback: string }
  | { decision: 'cancel' };

export interface ProviderIdSource {
  nextEventId(): string;
  nextProviderSessionId(): string;
}

export interface ProviderClock {
  now(): number;
}

export interface ProviderInteractionSink {
  requestApproval(input: ProviderApprovalRequest): Promise<ProviderApprovalDecision>;
  requestQuestion(input: ProviderQuestionRequest): Promise<ProviderQuestionAnswer>;
  requestPlanReview(input: ProviderPlanReviewRequest): Promise<ProviderPlanReviewDecision>;
}

export interface ProviderSnapshot {
  definition: ProviderDefinition;
  revision: number;
  readiness: 'ready' | 'missing' | 'unauthenticated' | 'unsupported' | 'unavailable' | 'error';
  executable?: { name: string; version: string };
  auth?: { accountLabel?: string; apiProviderLabel?: string; billingLabel?: string };
  models: readonly ProviderModel[];
  capabilities: ProviderCapabilities;
  error?: ProviderError;
}

export interface ProviderSessionCreateInput {
  target: SessionTarget;
  configuration: SessionConfiguration;
  expectedGeneration: number;
  cwd: string;
  eventSink: ProviderEventSink;
  interactionSink: ProviderInteractionSink;
  ids: ProviderIdSource;
  clock: ProviderClock;
}

export interface ProviderSessionResumeInput extends ProviderSessionCreateInput {
  resumeState: unknown;
}

export interface ProviderTurnInput {
  turnId: string;
  prompt: ProviderPrompt;
  configuration: SessionConfiguration;
}

export type ProviderTurnSettlement =
  | { status: 'completed' }
  | { status: 'failed'; error: ProviderError }
  | { status: 'interrupted' | 'cancelled' };

export interface ProviderSteerInput {
  turnId: string;
  prompt: ProviderPrompt;
}

export interface ProviderAdapter {
  readonly definition: ProviderDefinition;
  probe(signal: AbortSignal): Promise<ProviderSnapshot>;
  create(input: ProviderSessionCreateInput): Promise<ProviderSession>;
  resume(input: ProviderSessionResumeInput): Promise<ProviderSession>;
  close(deadline: ShutdownDeadline): Promise<void>;
}

export interface ProviderSession {
  readonly providerSessionId: string;
  readonly initialResumeState: unknown;
  activate(): void;
  // Acceptance only: a returned settlement would race the sole `turn.settled` event.
  startTurn(input: ProviderTurnInput): Promise<void>;
  steer(input: ProviderSteerInput): Promise<void>;
  interrupt(input: { turnId: string; runtimeGeneration: number }): Promise<void>;
  close(deadline: ShutdownDeadline): Promise<void>;
}

type StartTurnResult = Awaited<ReturnType<ProviderSession['startTurn']>>;
type _StartTurnIsNotSettlement = StartTurnResult extends ProviderTurnSettlement ? never : true;
export const START_TURN_ACCEPTANCE_ONLY: _StartTurnIsNotSettlement = true;

export class ProviderContractError extends Error implements ProviderError {
  readonly code: ProviderError['code'];
  readonly providerInstanceId: ProviderInstanceId;
  readonly recoveryAction: ProviderError['recoveryAction'];

  constructor(error: ProviderError) {
    super(error.message);
    this.name = 'ProviderContractError';
    this.code = error.code;
    this.providerInstanceId = error.providerInstanceId;
    this.recoveryAction = error.recoveryAction;
  }

  toProviderError(): ProviderError {
    return {
      code: this.code,
      providerInstanceId: this.providerInstanceId,
      message: this.message,
      recoveryAction: this.recoveryAction,
    };
  }
}

export function createProviderContractError(
  providerInstanceId: ProviderInstanceId,
  code: ProviderError['code'],
  message: string,
  recoveryAction: ProviderError['recoveryAction'],
): ProviderContractError {
  return new ProviderContractError(
    parseProviderError({
      code,
      providerInstanceId,
      message,
      recoveryAction,
    }),
  );
}

export function assertDefinitionConsistency(definition: ProviderDefinition): void {
  const expectedKind = providerDriverKindForInstance(definition.providerInstanceId);
  if (definition.providerDriverKind !== expectedKind) {
    throw createProviderContractError(
      definition.providerInstanceId,
      'invalid_provider_configuration',
      `providerDriverKind ${definition.providerDriverKind} does not match instance ${definition.providerInstanceId}`,
      'refresh',
    );
  }
}

export function assertConfigurationMatchesAdapter(
  definition: ProviderDefinition,
  configuration: SessionConfiguration,
): void {
  const parsed = parseSessionConfiguration(configuration);
  if (parsed.providerSelection.providerInstanceId !== definition.providerInstanceId) {
    throw createProviderContractError(
      definition.providerInstanceId,
      'invalid_provider_configuration',
      `provider selection ${parsed.providerSelection.providerInstanceId} does not match adapter ${definition.providerInstanceId}`,
      'refresh',
    );
  }
  assertDefinitionConsistency(definition);
}

export function assertCreateInputMatchesAdapter(
  definition: ProviderDefinition,
  input: ProviderSessionCreateInput,
): void {
  parseSessionTarget(input.target);
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw createProviderContractError(
      definition.providerInstanceId,
      'invalid_provider_configuration',
      'expectedGeneration must be a non-negative integer',
      'refresh',
    );
  }
  assertConfigurationMatchesAdapter(definition, input.configuration);
}

// Events before activate are session-owned: at most 512 events and 1,048,576 UTF-8 bytes.
export const PRE_ACTIVATION_MAX_EVENTS = 512;
export const PRE_ACTIVATION_MAX_BYTES = 1_048_576;

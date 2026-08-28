import {
  AutonomyLevel,
  DroidInteractionMode,
  ReasoningEffort as SdkReasoningEffort,
  type AskUserHandler,
  type DecompSessionType,
  type InitializeSessionRequestParams,
  type McpServerConfig,
  type PermissionHandler,
} from '@factory/droid-sdk';

import type { Autonomy, ReasoningEffort, SessionInteractionMode } from '../../protocol.js';
import { defineProviderCapabilities, type ProviderCapabilities } from '../providerTypes.js';
import type { ProviderDefinition } from '../providerTypes.js';

export const DROID_DEFINITION: ProviderDefinition = {
  providerDriverKind: 'droid',
  providerInstanceId: 'droid',
  displayName: 'Droid',
};

export const DROID_RESUME_SCHEMA_VERSION = 1;

export interface DroidResumeState {
  schemaVersion: 1;
  sessionId: string;
}

export function encodeDroidResumeState(sessionId: string): DroidResumeState {
  return { schemaVersion: DROID_RESUME_SCHEMA_VERSION, sessionId };
}

export function parseDroidResumeState(value: unknown): DroidResumeState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== DROID_RESUME_SCHEMA_VERSION) return undefined;
  if (typeof raw.sessionId !== 'string' || raw.sessionId.trim().length === 0) return undefined;
  return { schemaVersion: DROID_RESUME_SCHEMA_VERSION, sessionId: raw.sessionId };
}

export const DROID_INTERACTION_MODE_TABLE = [
  { droidex: 'auto', factory: DroidInteractionMode.Auto },
  { droidex: 'spec', factory: DroidInteractionMode.Spec },
  { droidex: 'agi', factory: DroidInteractionMode.AGI },
] as const satisfies readonly {
  droidex: SessionInteractionMode;
  factory: DroidInteractionMode;
}[];

export const DROID_AUTONOMY_TABLE = [
  { droidex: 'off', factory: AutonomyLevel.Off },
  { droidex: 'low', factory: AutonomyLevel.Low },
  { droidex: 'medium', factory: AutonomyLevel.Medium },
  { droidex: 'high', factory: AutonomyLevel.High },
] as const satisfies readonly { droidex: Autonomy; factory: AutonomyLevel }[];

export const DROID_REASONING_EFFORT_TABLE = [
  { droidex: 'none', factory: SdkReasoningEffort.None },
  { droidex: 'dynamic', factory: SdkReasoningEffort.Dynamic },
  { droidex: 'off', factory: SdkReasoningEffort.Off },
  { droidex: 'minimal', factory: SdkReasoningEffort.Minimal },
  { droidex: 'low', factory: SdkReasoningEffort.Low },
  { droidex: 'medium', factory: SdkReasoningEffort.Medium },
  { droidex: 'high', factory: SdkReasoningEffort.High },
  { droidex: 'xhigh', factory: SdkReasoningEffort.ExtraHigh },
  { droidex: 'max', factory: SdkReasoningEffort.Max },
] as const satisfies readonly { droidex: ReasoningEffort; factory: SdkReasoningEffort }[];

export const APPROVAL_DECISION_TO_OUTCOME = [
  { decision: 'allow_once', outcome: 'proceed_once' },
  { decision: 'allow_session', outcome: 'proceed_always' },
  { decision: 'deny', outcome: 'cancel' },
  { decision: 'cancel', outcome: 'cancel' },
] as const;

export function mapInteractionMode(mode: SessionInteractionMode): DroidInteractionMode {
  const row = DROID_INTERACTION_MODE_TABLE.find((entry) => entry.droidex === mode);
  return row?.factory ?? DroidInteractionMode.Auto;
}

export function mapAutonomy(autonomy: Autonomy): AutonomyLevel {
  const row = DROID_AUTONOMY_TABLE.find((entry) => entry.droidex === autonomy);
  return row?.factory ?? AutonomyLevel.Low;
}

export function factoryReasoningEffort(reasoning: ReasoningEffort): SdkReasoningEffort {
  const row = DROID_REASONING_EFFORT_TABLE.find((entry) => entry.droidex === reasoning);
  return row?.factory ?? SdkReasoningEffort.Medium;
}

export function droidCapabilities(): ProviderCapabilities {
  return defineProviderCapabilities({
    modes: ['auto', 'spec', 'agi'],
    autonomyLevels: ['off', 'low', 'medium', 'high'],
    modelChange: 'before_turn',
    resume: true,
    steer: true,
    interrupt: true,
    approvals: true,
    questions: true,
    planReview: true,
    context: true,
    compaction: true,
    skills: true,
    slashCommands: true,
    mcpUse: true,
    mcpManagement: true,
    rewind: true,
    fork: true,
    observationalTasks: true,
    addressableChildren: true,
    missionControl: true,
    browser: true,
    usageReporting: true,
    reasoningStream: true,
  });
}

export interface RuntimeHandlers {
  permissionHandler?: PermissionHandler;
  askUserHandler?: AskUserHandler;
  mcpServers?: McpServerConfig[];
  cwd?: string;
}

export interface CreateRuntimeSessionOptions extends RuntimeHandlers {
  cwd: string;
  interactionMode: SessionInteractionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
  compactionTokenLimit?: number;
  compactionThresholdCheckEnabled?: boolean;
  specModeModelId?: string;
  specModeReasoningEffort?: ReasoningEffort;
  autonomyLevel?: Autonomy;
  decompSessionType?: DecompSessionType;
  missionId?: string;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
}

export function createInitializeSessionParams(
  options: CreateRuntimeSessionOptions,
): InitializeSessionRequestParams & Record<string, unknown> {
  const params: InitializeSessionRequestParams & Record<string, unknown> = {
    machineId: 'default',
    cwd: options.cwd,
    interactionMode: mapInteractionMode(options.interactionMode),
    sessionLocation: 'droid-control',
    tags: tagsFor(options),
  };

  if (options.modelId) params.modelId = options.modelId;
  if (options.reasoningEffort)
    params.reasoningEffort = factoryReasoningEffort(options.reasoningEffort);
  if (options.compactionModel) params.compactionModel = options.compactionModel;
  if (options.compactionTokenLimit !== undefined)
    params.compactionTokenLimit = options.compactionTokenLimit;
  if (options.compactionThresholdCheckEnabled !== undefined)
    params.compactionThresholdCheckEnabled = options.compactionThresholdCheckEnabled;
  if (options.specModeModelId) params.specModeModelId = options.specModeModelId;
  if (options.specModeReasoningEffort)
    params.specModeReasoningEffort = factoryReasoningEffort(options.specModeReasoningEffort);
  if (options.autonomyLevel) params.autonomyLevel = mapAutonomy(options.autonomyLevel);
  if (options.decompSessionType) params.decompSessionType = options.decompSessionType;
  if (options.missionId) params.decompMissionId = options.missionId;
  if (options.mcpServers?.length) params.mcpServers = options.mcpServers;
  const missionSettings = missionSettingsFor(options);
  if (missionSettings) params.missionSettings = missionSettings;

  return params;
}

function tagsFor(options: CreateRuntimeSessionOptions): InitializeSessionRequestParams['tags'] {
  let kind = 'chat';
  if (options.interactionMode === 'agi') kind = 'mission_orchestrator';
  else if (options.interactionMode === 'spec') kind = 'spec';
  return [
    { name: 'droid-control', metadata: { source: 'droid-control' } },
    { name: 'kind', metadata: { kind } },
    ...(options.missionId
      ? [{ name: 'missionId', metadata: { missionId: options.missionId } }]
      : []),
  ];
}

function missionSettingsFor(
  options: CreateRuntimeSessionOptions,
): Record<string, unknown> | undefined {
  if (
    !options.workerModelId &&
    !options.workerReasoningEffort &&
    !options.validatorModelId &&
    !options.validatorReasoningEffort
  )
    return undefined;
  return {
    ...(options.workerModelId ? { workerModel: options.workerModelId } : {}),
    ...(options.workerReasoningEffort
      ? { workerReasoningEffort: factoryReasoningEffort(options.workerReasoningEffort) }
      : {}),
    ...(options.validatorModelId ? { validationWorkerModel: options.validatorModelId } : {}),
    ...(options.validatorReasoningEffort
      ? {
          validationWorkerReasoningEffort: factoryReasoningEffort(options.validatorReasoningEffort),
        }
      : {}),
  };
}

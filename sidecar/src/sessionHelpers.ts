import type {
  Autonomy,
  ClientCommand,
  DroidMissionConfiguration,
  FactoryDefaultSettings,
  ReasoningEffort,
  SessionConfiguration,
  SessionInteractionMode,
  SessionPhase,
  SessionSummary,
} from './protocol.js';
import type { CompactionTokenLimitPatch } from './compaction.js';
import { bridgeFeature } from './missionFeatures.js';
import {
  assertDroidMissionConfigurationAllowed,
  droidReasoningEffortFromSelection,
  droidSessionConfiguration,
  parseSessionConfiguration,
} from './providers/providerIdentity.js';
import { stringValue } from './values.js';

export interface SessionInitResult {
  cwd?: string | undefined;
  session?:
    | {
        decompSessionType?: unknown;
        decompMissionId?: unknown;
        cwd?: unknown;
        title?: unknown;
        sessionTitle?: unknown;
        [key: string]: unknown;
      }
    | undefined;
  settings?:
    | {
        modelId?: string | undefined;
        reasoningEffort?: string | undefined;
        compactionModel?: string | undefined;
        compactionTokenLimit?: number | undefined;
        compactionTokenLimitPerModel?: Record<string, number> | undefined;
        interactionMode?: string | undefined;
        autonomyLevel?: string | undefined;
      }
    | undefined;
  mission?: { state?: string | undefined; features?: unknown[] | undefined } | undefined;
}

const STATE_TO_PHASE: Record<string, SessionPhase> = {
  initializing: 'initializing',
  running: 'running',
  paused: 'paused',
  orchestrator_turn: 'orchestrator_turn',
  completed: 'completed',
  failed: 'failed',
  awaiting_input: 'running',
};

export function normalizeAutonomy(value: unknown): Autonomy | undefined {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

export function uniqueStrings(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function defaultsModeForSummary(summary: SessionSummary): SessionInteractionMode {
  if (summary.sessionPurpose === 'mission-control') return 'agi';
  if (summary.configuration.interactionMode === 'spec') return 'spec';
  return 'auto';
}

export function reasoningValue(value?: string): ReasoningEffort | undefined {
  if (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  ) {
    return value;
  }
  return undefined;
}

interface SessionClassification {
  sessionPurpose: SessionSummary['sessionPurpose'];
  interactionMode: SessionInteractionMode;
  role: SessionSummary['role'];
  missionId?: string;
}

function classifySession(
  init: SessionInitResult,
  historical?: SessionSummary,
): SessionClassification {
  const session = init.session ?? {};
  const decompType = stringValue(session.decompSessionType);
  const missionId = stringValue(session.decompMissionId) ?? historical?.missionId;

  if (decompType === 'worker' || decompType === 'validator') {
    throw new Error('Child provider sessions cannot be resumed as top-level sessions.');
  }

  const mode = init.settings?.interactionMode ?? (init.mission ? 'agi' : undefined);
  if (isMissionControl(init, historical, decompType, missionId)) {
    return missionControlClassification(mode, historical, missionId);
  }
  return standardSessionClassification(mode, historical);
}

function standardSessionClassification(
  mode: string | undefined,
  historical?: SessionSummary,
): ReturnType<typeof classifySession> {
  if (mode === 'spec' || historical?.configuration.interactionMode === 'spec') {
    return {
      sessionPurpose: historical?.sessionPurpose ?? 'chat',
      interactionMode: 'spec',
      role: 'primary',
    };
  }

  return {
    sessionPurpose: historical?.sessionPurpose ?? 'chat',
    interactionMode: mode === 'agi' ? 'agi' : 'auto',
    role: 'primary',
  };
}

function isMissionControl(
  init: SessionInitResult,
  historical: SessionSummary | undefined,
  decompType: string | undefined,
  missionId: string | undefined,
): boolean {
  return (
    decompType === 'orchestrator' ||
    Boolean(missionId) ||
    historical?.sessionPurpose === 'mission-control' ||
    (Boolean(init.mission) && !historical?.sessionPurpose)
  );
}

function missionControlClassification(
  mode: string | undefined,
  historical: SessionSummary | undefined,
  missionId: string | undefined,
): ReturnType<typeof classifySession> {
  const resolvedMissionId = missionId ?? historical?.appSessionId;
  const interactionMode =
    mode === 'auto' || mode === 'spec' || mode === 'agi'
      ? mode
      : (historical?.configuration.interactionMode ?? 'agi');
  return {
    sessionPurpose: 'mission-control',
    interactionMode,
    role: 'primary',
    ...(resolvedMissionId !== undefined ? { missionId: resolvedMissionId } : {}),
  };
}

export function phaseFromState(state?: string): SessionPhase | undefined {
  return state ? STATE_TO_PHASE[state] : undefined;
}

function phaseFromInit(init: SessionInitResult): SessionPhase {
  return phaseFromState(init.mission?.state) ?? 'paused';
}

type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

export function requireCreateConfiguration(command: SessionCreateCommand): SessionConfiguration {
  const configuration = parseSessionConfiguration(command.configuration);
  assertDroidMissionConfigurationAllowed(configuration, command.droidMissionConfiguration);
  return configuration;
}

export function createModelDefaultsForMode(
  mode: SessionInteractionMode,
  command: { modelId?: string; reasoningEffort?: ReasoningEffort },
  defaults: Pick<
    FactoryDefaultSettings,
    | 'modelId'
    | 'reasoningEffort'
    | 'specModelId'
    | 'specReasoningEffort'
    | 'missionOrchestratorModelId'
    | 'missionOrchestratorReasoningEffort'
  >,
): { modelId?: string; reasoningEffort?: ReasoningEffort } {
  const modelId = command.modelId ?? modelDefaultForMode(mode, defaults);
  const reasoningEffort = command.reasoningEffort ?? reasoningDefaultForMode(mode, defaults);
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

export function createMissionConfigurationForMode(
  mode: SessionInteractionMode,
  command: SessionCreateCommand,
  defaults: Pick<
    FactoryDefaultSettings,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  >,
): DroidMissionConfiguration | undefined {
  if (mode !== 'agi') return undefined;
  if (command.droidMissionConfiguration) return command.droidMissionConfiguration;
  const workerModelId = defaults.workerModelId;
  const validatorModelId = defaults.validatorModelId;
  if (!workerModelId || !validatorModelId) return undefined;
  return {
    worker: {
      modelId: workerModelId,
      ...(defaults.workerReasoningEffort !== undefined
        ? { reasoningEffort: defaults.workerReasoningEffort }
        : {}),
    },
    validator: {
      modelId: validatorModelId,
      ...(defaults.validatorReasoningEffort !== undefined
        ? { reasoningEffort: defaults.validatorReasoningEffort }
        : {}),
    },
  };
}

export function createDefaultsModeForCommand(
  command: SessionCreateCommand,
  interactionMode: SessionInteractionMode,
): SessionInteractionMode {
  if (command.sessionPurpose === 'mission-control') return 'agi';
  return interactionMode === 'spec' ? 'spec' : 'auto';
}

export function buildCreatedSessionSummary(input: {
  command: SessionCreateCommand;
  appSessionId: string;
  configuration: SessionConfiguration;
  compactionModel: string;
  mission?: DroidMissionConfiguration;
  maxContextTokens?: number;
  compactionTokenLimit?: number;
  phase?: SessionPhase;
  now: number;
}): SessionSummary {
  const { command, appSessionId } = input;
  const cwd = command.cwd ?? '';
  return {
    appSessionId: input.appSessionId,
    ...(command.sessionPurpose === 'mission-control' ? { missionId: appSessionId } : {}),
    sessionPurpose: command.sessionPurpose,
    role: 'primary',
    title: command.title,
    goal: command.goal,
    cwd,
    workspaceKind: cwd ? 'folder' : 'none',
    configuration: input.configuration,
    ...(input.mission !== undefined ? { droidMissionConfiguration: input.mission } : {}),
    compactionModel: input.compactionModel,
    phase: input.phase ?? 'intake',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    ...(input.maxContextTokens !== undefined ? { maxContextTokens: input.maxContextTokens } : {}),
    ...(input.compactionTokenLimit !== undefined
      ? { compactionTokenLimit: input.compactionTokenLimit }
      : {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

interface BuildResumedSessionInput {
  init: SessionInitResult;
  historical?: SessionSummary | undefined;
  appSessionId: string;
  providerSessionId: string;
  defaults: FactoryDefaultSettings;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  now: number;
}

export function buildResumedSession(input: BuildResumedSessionInput): {
  summary: SessionSummary;
  exposedCompaction: CompactionTokenLimitPatch;
} {
  const classification = classifySession(input.init, input.historical);
  const { missionId, interactionMode, ...classified } = classification;
  const resumed = resumedModelSettings(input, interactionMode);
  return {
    summary: {
      appSessionId: input.appSessionId,
      ...classified,
      ...(missionId !== undefined ? { missionId } : {}),
      ...resumedLocation(input),
      ...resumed,
      phase:
        classification.sessionPurpose === 'mission-control'
          ? phaseFromInit(input.init)
          : (input.historical?.phase ?? 'paused'),
      streaming: false,
      queuedSends: 0,
      ...(input.historical?.proposal !== undefined ? { proposal: input.historical.proposal } : {}),
      features: resumedFeatures(input.init, classification.sessionPurpose),
      ...resumedUsage(input.historical),
      createdAt: input.historical?.createdAt ?? input.now,
      // Resuming (to read or to prepare a send) is not user-visible activity:
      // keep the historical updatedAt so the session does not jump to the top
      // of the sidebar or read as unread. A real turn moves it when it settles.
      updatedAt: input.historical?.updatedAt ?? input.now,
    },
    exposedCompaction: exposedCompaction(input.init),
  };
}

function resumedLocation(
  input: BuildResumedSessionInput,
): Pick<SessionSummary, 'title' | 'goal' | 'cwd' | 'workspaceKind'> {
  const historical = input.historical;
  const cwd =
    historical?.workspaceKind === 'none'
      ? ''
      : firstNonEmpty(
          historical?.cwd,
          stringValue(input.init.cwd),
          stringValue(input.init.session?.cwd),
        );
  const title = firstNonEmpty(
    stringValue(input.init.session?.title),
    stringValue(input.init.session?.sessionTitle),
    historical?.title,
  );
  return {
    title: title.length > 0 ? title : `Session ${input.appSessionId.slice(0, 8)}`,
    goal: historical?.goal ?? '',
    cwd,
    workspaceKind: cwd ? 'folder' : (historical?.workspaceKind ?? 'none'),
  };
}

type ResumedModelSettings = Pick<SessionSummary, 'configuration' | 'compactionModel'> &
  Partial<Pick<SessionSummary, 'droidMissionConfiguration' | 'maxContextTokens'>>;

function resumedModelSettings(
  input: BuildResumedSessionInput,
  interactionMode: SessionInteractionMode,
): ResumedModelSettings {
  const { init, historical, defaults } = input;
  const historicalSelection = historical?.configuration.providerSelection;
  const modelId =
    init.settings?.modelId ?? historicalSelection?.modelId ?? defaults.modelId ?? 'default';
  const reasoningEffort =
    reasoningValue(init.settings?.reasoningEffort) ??
    (historicalSelection ? droidReasoningEffortFromSelection(historicalSelection) : undefined) ??
    defaults.reasoningEffort;
  const autonomy =
    normalizeAutonomy(init.settings?.autonomyLevel) ??
    historical?.configuration.autonomy ??
    defaults.autonomy ??
    'low';
  const maxContextTokens = historical?.maxContextTokens ?? input.maxContextTokensForModel(modelId);
  const mission = resumedMissionConfiguration(historical, defaults, interactionMode);
  return {
    configuration: droidSessionConfiguration({
      modelId,
      interactionMode,
      autonomy,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    }),
    compactionModel:
      init.settings?.compactionModel ??
      historical?.compactionModel ??
      defaults.compactionModel ??
      'current-model',
    ...(mission !== undefined ? { droidMissionConfiguration: mission } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  };
}

function resumedMissionConfiguration(
  historical: SessionSummary | undefined,
  defaults: FactoryDefaultSettings,
  interactionMode: SessionInteractionMode,
): DroidMissionConfiguration | undefined {
  if (historical?.droidMissionConfiguration) return historical.droidMissionConfiguration;
  if (interactionMode !== 'agi' && historical?.sessionPurpose !== 'mission-control')
    return undefined;
  const workerModelId = defaults.workerModelId;
  const validatorModelId = defaults.validatorModelId;
  if (!workerModelId || !validatorModelId) return undefined;
  return {
    worker: {
      modelId: workerModelId,
      ...(defaults.workerReasoningEffort !== undefined
        ? { reasoningEffort: defaults.workerReasoningEffort }
        : {}),
    },
    validator: {
      modelId: validatorModelId,
      ...(defaults.validatorReasoningEffort !== undefined
        ? { reasoningEffort: defaults.validatorReasoningEffort }
        : {}),
    },
  };
}

type ResumedUsage = Pick<SessionSummary, 'tokensIn' | 'tokensOut' | 'contextTokens'> &
  Partial<
    Pick<
      SessionSummary,
      'contextRemainingTokens' | 'contextAccuracy' | 'contextUpdatedAt' | 'autoCompactions'
    >
  >;

function resumedUsage(historical?: SessionSummary): ResumedUsage {
  return {
    tokensIn: historical?.tokensIn ?? 0,
    tokensOut: historical?.tokensOut ?? 0,
    // Current-context telemetry is live provider state, not durable session
    // history. A resumed session refreshes it immediately; carrying an old
    // exact stream reading across clients can pin the meter at 100% forever.
    contextTokens: 0,
    ...(historical?.autoCompactions !== undefined
      ? { autoCompactions: historical.autoCompactions }
      : {}),
  };
}

function resumedFeatures(
  init: SessionInitResult,
  purpose: SessionSummary['sessionPurpose'],
): SessionSummary['features'] {
  return purpose === 'mission-control' ? (init.mission?.features ?? []).map(bridgeFeature) : [];
}

function exposedCompaction(init: SessionInitResult): CompactionTokenLimitPatch {
  return {
    ...(init.settings?.compactionTokenLimit !== undefined
      ? { compactionTokenLimit: init.settings.compactionTokenLimit }
      : {}),
    ...(init.settings?.compactionTokenLimitPerModel !== undefined
      ? { compactionTokenLimitPerModel: init.settings.compactionTokenLimitPerModel }
      : {}),
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  return values.find(Boolean) ?? '';
}

export function modelDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<FactoryDefaultSettings, 'modelId' | 'specModelId' | 'missionOrchestratorModelId'>,
): string | undefined {
  if (mode === 'spec') return defaults.specModelId ?? defaults.modelId;
  if (mode === 'agi') return defaults.missionOrchestratorModelId ?? defaults.modelId;
  return defaults.modelId;
}

function reasoningDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<
    FactoryDefaultSettings,
    'reasoningEffort' | 'specReasoningEffort' | 'missionOrchestratorReasoningEffort'
  >,
): ReasoningEffort | undefined {
  if (mode === 'spec') return defaults.specReasoningEffort ?? defaults.reasoningEffort;
  if (mode === 'agi') {
    return defaults.missionOrchestratorReasoningEffort ?? defaults.reasoningEffort;
  }
  return defaults.reasoningEffort;
}

// A user Stop/interrupt makes the SDK stream throw (a cancellation message or an
// AbortError). That is a deliberate stop, not a failure, so callers must settle
// quietly instead of surfacing it as an error.
export function isUserCancellation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') return true;
  const m = errMsg(err).toLowerCase();
  return (
    m.includes('interrupted by user') ||
    m.includes('cancelled by user') ||
    m.includes('canceled by user') ||
    m.includes('request interrupted') ||
    m.includes('request cancelled') ||
    m.includes('request canceled')
  );
}

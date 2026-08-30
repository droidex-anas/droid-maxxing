import type {
  Autonomy,
  ProviderCapabilitySnapshot,
  ProviderSelection,
  ReasoningEffort,
  SessionConfiguration,
  SessionInteractionMode,
  SessionSummary,
} from '../types/bridge';

const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'dynamic',
]);

export function droidSessionConfiguration(input: {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode: SessionInteractionMode;
  autonomy: Autonomy;
}): SessionConfiguration {
  return buildSessionConfiguration({ providerInstanceId: 'droid', ...input });
}

export function buildSessionConfiguration(input: {
  providerInstanceId: ProviderSelection['providerInstanceId'];
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode: SessionInteractionMode;
  autonomy: Autonomy;
}): SessionConfiguration {
  return {
    providerSelection: {
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      options:
        input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort },
    },
    interactionMode: input.interactionMode,
    autonomy: input.autonomy,
  };
}

export function sessionProviderInstanceId(
  summary: SessionSummary,
): ProviderSelection['providerInstanceId'] {
  return summary.configuration.providerSelection.providerInstanceId;
}

export function configurationForComposer(input: {
  providerInstanceId: ProviderSelection['providerInstanceId'];
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode: SessionInteractionMode;
  autonomy: Autonomy;
  capabilities?: ProviderCapabilitySnapshot;
}): SessionConfiguration {
  const modes = input.capabilities?.modes;
  const autonomyLevels = input.capabilities?.autonomyLevels;
  const interactionMode =
    !modes || modes.includes(input.interactionMode) ? input.interactionMode : (modes[0] ?? 'auto');
  const autonomy =
    !autonomyLevels || autonomyLevels.includes(input.autonomy)
      ? input.autonomy
      : (autonomyLevels[0] ?? 'off');
  const reasoningEffort =
    input.capabilities && !input.capabilities.reasoningStream ? undefined : input.reasoningEffort;
  return buildSessionConfiguration({
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    reasoningEffort,
    interactionMode,
    autonomy,
  });
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.has(value);
}

export function droidReasoningEffortFromSelection(
  selection: ProviderSelection,
): ReasoningEffort | undefined {
  const value = selection.options.reasoningEffort;
  if (typeof value !== 'string' || !isReasoningEffort(value)) return undefined;
  return value;
}

export function sessionModelId(summary: SessionSummary): string {
  return summary.configuration.providerSelection.modelId;
}

export function sessionInteractionMode(summary: SessionSummary): SessionInteractionMode {
  return summary.configuration.interactionMode;
}

export function sessionAutonomy(summary: SessionSummary): Autonomy {
  return summary.configuration.autonomy;
}

export function sessionReasoningEffort(summary: SessionSummary): ReasoningEffort | undefined {
  return droidReasoningEffortFromSelection(summary.configuration.providerSelection);
}

export function withProviderSelection(
  configuration: SessionConfiguration,
  patch: Partial<Pick<ProviderSelection, 'modelId'>> & {
    options?: Record<string, string | number | boolean>;
  },
): SessionConfiguration {
  return {
    ...configuration,
    providerSelection: {
      ...configuration.providerSelection,
      ...patch,
      options: patch.options ?? configuration.providerSelection.options,
    },
  };
}

export function withSessionConfiguration(
  summary: SessionSummary,
  configuration: SessionConfiguration,
): SessionSummary {
  return { ...summary, configuration };
}

const PROVIDER_INSTANCE_IDS = new Set(['droid', 'codex', 'claude', 'cursor', 'grok']);
const INTERACTION_MODES = new Set(['auto', 'spec', 'agi']);
const AUTONOMY_LEVELS = new Set(['off', 'low', 'medium', 'high']);

export function isSessionConfiguration(value: unknown): value is SessionConfiguration {
  if (typeof value !== 'object' || value === null) return false;
  const configuration = value as Partial<SessionConfiguration>;
  const selection = configuration.providerSelection;
  if (typeof selection !== 'object' || selection === null) return false;
  if (
    typeof selection.providerInstanceId !== 'string' ||
    !PROVIDER_INSTANCE_IDS.has(selection.providerInstanceId)
  ) {
    return false;
  }
  if (typeof selection.modelId !== 'string' || selection.modelId.length === 0) return false;
  if (typeof selection.options !== 'object' || selection.options === null) return false;
  if (
    typeof configuration.interactionMode !== 'string' ||
    !INTERACTION_MODES.has(configuration.interactionMode)
  ) {
    return false;
  }
  if (typeof configuration.autonomy !== 'string' || !AUTONOMY_LEVELS.has(configuration.autonomy)) {
    return false;
  }
  for (const option of Object.values(selection.options)) {
    if (typeof option === 'number') {
      if (!Number.isFinite(option)) return false;
      continue;
    }
    if (typeof option !== 'string' && typeof option !== 'boolean') return false;
  }
  return true;
}

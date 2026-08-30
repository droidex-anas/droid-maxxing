import type {
  ModelInfo,
  ProviderInstanceId,
  ProviderWireSnapshot,
  SessionSummary,
} from '../../types/bridge';

export function activeHarnessId(input: {
  activeSession?: Pick<SessionSummary, 'configuration'> | null;
  draftProviderInstanceId: ProviderInstanceId;
}): ProviderInstanceId {
  return (
    input.activeSession?.configuration.providerSelection.providerInstanceId ??
    input.draftProviderInstanceId
  );
}

export function snapshotForHarness(
  snapshots: readonly ProviderWireSnapshot[],
  providerInstanceId: ProviderInstanceId,
): ProviderWireSnapshot | undefined {
  return snapshots.find(
    (snapshot) => snapshot.definition.providerInstanceId === providerInstanceId,
  );
}

export function modelsForHarness(input: {
  harnessId: ProviderInstanceId;
  droidModels: readonly ModelInfo[];
  snapshots: readonly ProviderWireSnapshot[];
}): ModelInfo[] {
  if (input.harnessId === 'droid' && input.droidModels.length > 0) {
    return [...input.droidModels];
  }
  const snapshot = snapshotForHarness(input.snapshots, input.harnessId);
  if (!snapshot) return [];
  return snapshot.models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: snapshot.definition.displayName,
    isCustom: false,
    isDefault: model.isDefault,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    defaultReasoningEffort: model.supportedReasoningEfforts.at(-1),
  }));
}

export function defaultModelId(models: readonly ModelInfo[]): string | undefined {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id;
}

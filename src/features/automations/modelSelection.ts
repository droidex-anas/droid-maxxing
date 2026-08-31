import type { ModelInfo, ReasoningEffort } from '../../types/bridge';

export function reasoningForModel(
  model: ModelInfo | undefined,
  current: ReasoningEffort | null | undefined,
): ReasoningEffort {
  if (!model) return current ?? 'medium';
  const supported = model.supportedReasoningEfforts;
  if (supported?.length) {
    if (current && supported.includes(current)) return current;
    const fallback = model.defaultReasoningEffort;
    if (fallback && supported.includes(fallback)) return fallback;
    return supported.at(-1) ?? 'medium';
  }
  return model.defaultReasoningEffort ?? current ?? 'medium';
}

export function automationModelSelectionIssue(
  models: readonly ModelInfo[],
  modelId: string | null,
  reasoningEffort: ReasoningEffort | null,
): string | null {
  if (!modelId) return 'Choose a model from your DROIDEX model catalog.';
  if (!reasoningEffort) return 'Choose a reasoning level for this automation.';
  // The catalog arrives asynchronously at startup. Do not temporarily mark a
  // saved automation incomplete while that first catalog request is in flight.
  if (models.length === 0) return null;

  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    // Custom and BYOK models are often absent from the CLI catalog. Keep the
    // inherited id; session.create still passes it through. A catalog model
    // that disappeared is only rejected when the catalog actually lists it.
    return null;
  }
  const supported = model.supportedReasoningEfforts;
  if (supported?.length && !supported.includes(reasoningEffort)) {
    return `${model.displayName} does not support ${reasoningEffort} reasoning. Choose one of its available reasoning levels.`;
  }
  if (
    !supported?.length &&
    model.defaultReasoningEffort &&
    reasoningEffort !== model.defaultReasoningEffort
  ) {
    return `${model.displayName} currently supports ${model.defaultReasoningEffort} reasoning for this catalog entry.`;
  }
  return null;
}

export function validateAutomationModelSelection(
  models: readonly ModelInfo[],
  modelId: string | null,
  reasoningEffort: ReasoningEffort | null,
): string | null {
  if (!modelId) return 'Choose a model from your DROIDEX model catalog.';
  if (!reasoningEffort) return 'Choose a reasoning level for the model.';
  // Catalog-missing custom/BYOK selections are already concrete; do not block
  // confirm while the catalog request is still in flight.
  if (models.length === 0) return null;
  return automationModelSelectionIssue(models, modelId, reasoningEffort);
}

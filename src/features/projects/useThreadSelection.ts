import { useEffect, useState } from 'react';
import { useStoreSelector } from '../../hooks/useStore';
import { refreshProviders } from '../../lib/commands';
import type {
  Autonomy,
  ProviderKind,
  ProviderStatus,
  ReasoningEffort,
  SessionSummary,
} from '../../types/bridge';
import { providerDefaultModel, providerUnavailableReason } from '../providers/providerIdentity';
import type { ThreadInput } from './types';

export interface ThreadSelection {
  provider: ProviderKind;
  modelId: string;
  reasoning: ReasoningEffort | undefined;
  autonomy: Autonomy;
}

export function useThreadSelection(owner: SessionSummary | undefined) {
  useEffect(() => {
    refreshProviders();
  }, []);
  const statuses = useStoreSelector((state) => state.providerStatuses);
  const defaultAutonomy = useStoreSelector((state) => state.defaultAutonomy);
  const [value, setValue] = useState<ThreadSelection>(() => ({
    provider: owner?.provider ?? 'droid',
    modelId: owner?.modelId ?? '',
    reasoning: undefined,
    autonomy: owner?.autonomy ?? defaultAutonomy,
  }));
  return { value, setValue, catalog: selectionCatalog(value, statuses) };
}

export function selectionCatalog(value: ThreadSelection, statuses: ProviderStatus[]) {
  const status = statuses.find((item) => item.provider === value.provider);
  const models = status?.models ?? [];
  const defaultModel = providerDefaultModel(value.provider, models, statuses);
  const selected = models.find((item) => item.id === value.modelId);
  const model = selected ?? (value.modelId ? undefined : defaultModel);
  return {
    models,
    defaultModel,
    efforts: model?.supportedReasoningEfforts ?? [],
    unavailable: providerUnavailableReason(status),
  };
}

export type ThreadCatalog = ReturnType<typeof selectionCatalog>;

export function buildThreadInput(
  draft: { title: string; prompt: string; workspace: string },
  value: ThreadSelection,
  catalog: ThreadCatalog,
): ThreadInput {
  const prompt = draft.prompt.trim();
  const modelId = value.modelId || catalog.defaultModel?.id;
  const reasoning =
    value.reasoning && catalog.efforts.includes(value.reasoning) ? value.reasoning : undefined;
  const title = draft.title.trim() || prompt.split('\n')[0].slice(0, 80);
  const cwd = draft.workspace.trim();
  return {
    title,
    prompt,
    provider: value.provider,
    autonomy: value.autonomy,
    ...(cwd ? { cwd } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
  };
}

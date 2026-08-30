import type { ProviderInstanceId, ReasoningEffort } from '../../types/bridge';
import { isProviderInstanceId } from './harnessIdentity';

export const PROVIDER_PREFERENCES_KEY = 'droidex-provider-preferences-v1';

export interface HarnessSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ProviderDraftRecord {
  draftProviderInstanceId: ProviderInstanceId;
  selections: Partial<Record<ProviderInstanceId, HarnessSelection>>;
}

const DEFAULT_DRAFT: ProviderDraftRecord = {
  draftProviderInstanceId: 'droid',
  selections: {},
};

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function loadProviderDraft(): ProviderDraftRecord {
  try {
    const raw = getLocalStorage()?.getItem(PROVIDER_PREFERENCES_KEY);
    if (!raw) return DEFAULT_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    return parseProviderDraft(parsed) ?? DEFAULT_DRAFT;
  } catch {
    return DEFAULT_DRAFT;
  }
}

export function saveProviderDraft(record: ProviderDraftRecord): void {
  try {
    getLocalStorage()?.setItem(PROVIDER_PREFERENCES_KEY, JSON.stringify(record));
  } catch {
    /* ignore */
  }
}

export function persistDraftHarness(providerInstanceId: ProviderInstanceId): void {
  const current = loadProviderDraft();
  saveProviderDraft({ ...current, draftProviderInstanceId: providerInstanceId });
}

export function persistHarnessSelection(
  providerInstanceId: ProviderInstanceId,
  selection: HarnessSelection,
): void {
  const current = loadProviderDraft();
  saveProviderDraft({
    ...current,
    selections: { ...current.selections, [providerInstanceId]: selection },
  });
}

export function applyDraftSelection<
  T extends { primary: { modelId?: string; reasoning: ReasoningEffort } },
>(config: T, draft: ProviderDraftRecord): T {
  if (draft.draftProviderInstanceId === 'droid') return config;
  const selection = draft.selections[draft.draftProviderInstanceId];
  if (!selection) return config;
  return {
    ...config,
    primary: {
      modelId: selection.modelId,
      reasoning: selection.reasoningEffort ?? config.primary.reasoning,
    },
  };
}

export function parseProviderDraft(value: unknown): ProviderDraftRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<ProviderDraftRecord>;
  if (!isProviderInstanceId(record.draftProviderInstanceId)) return undefined;
  if (typeof record.selections !== 'object' || record.selections === null) return undefined;
  const selections: ProviderDraftRecord['selections'] = {};
  for (const [key, selection] of Object.entries(record.selections)) {
    if (!isProviderInstanceId(key) || !isHarnessSelection(selection)) continue;
    selections[key] = selection;
  }
  return {
    draftProviderInstanceId: record.draftProviderInstanceId,
    selections,
  };
}

function isHarnessSelection(value: unknown): value is HarnessSelection {
  if (typeof value !== 'object' || value === null) return false;
  const selection = value as Partial<HarnessSelection>;
  if (typeof selection.modelId !== 'string' || selection.modelId.length === 0) return false;
  if (selection.reasoningEffort !== undefined && !isReasoningEffort(selection.reasoningEffort)) {
    return false;
  }
  return true;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  );
}

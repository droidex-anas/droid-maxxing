import type { PersistedChildSession } from './ChildSessionState.js';
import type {
  ProviderBinding,
  SessionStore,
  StoredChildSession,
  UpsertChildInput,
} from './persistence/SessionStore.js';

export interface ChildPersistence {
  list(parentAppSessionId: string): PersistedChildSession[];
  get(parentAppSessionId: string, childSessionId: string): PersistedChildSession | undefined;
  upsert(child: PersistedChildSession, parentBinding: ProviderBinding): boolean | undefined;
}

export function persistedChildFromStored(stored: StoredChildSession): PersistedChildSession {
  const previous = stored.binding.previousProviderSessionIds;
  return {
    parentAppSessionId: stored.summary.parentAppSessionId,
    childSessionId: stored.summary.childSessionId,
    role: stored.summary.role,
    status: stored.summary.status,
    modelId: stored.summary.modelId,
    transcriptAvailable: stored.summary.transcriptAvailable,
    updatedAt: 0,
    ...(stored.binding.providerSessionId
      ? { providerSessionId: stored.binding.providerSessionId }
      : {}),
    ...(previous.length > 0 ? { previousProviderSessionIds: previous } : {}),
    ...(stored.summary.label ? { label: stored.summary.label } : {}),
    ...(stored.summary.prompt ? { prompt: stored.summary.prompt } : {}),
    ...(stored.summary.reasoningEffort ? { reasoningEffort: stored.summary.reasoningEffort } : {}),
    ...(stored.summary.spawnLink ? { spawnLink: stored.summary.spawnLink } : {}),
    ...(stored.summary.startedAt === undefined ? {} : { startedAt: stored.summary.startedAt }),
  };
}

export function upsertChildInputFromPersisted(
  record: PersistedChildSession,
  parentBinding: Pick<ProviderBinding, 'providerDriverKind' | 'providerInstanceId'>,
): UpsertChildInput {
  return {
    parentAppSessionId: record.parentAppSessionId,
    childSessionId: record.childSessionId,
    summary: {
      parentAppSessionId: record.parentAppSessionId,
      childSessionId: record.childSessionId,
      role: record.role,
      status: record.status,
      modelId: record.modelId,
      transcriptAvailable: record.transcriptAvailable,
      streamFidelity: 'state',
      ...(record.label ? { label: record.label } : {}),
      ...(record.prompt ? { prompt: record.prompt } : {}),
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    },
    binding: {
      providerDriverKind: parentBinding.providerDriverKind,
      providerInstanceId: parentBinding.providerInstanceId,
      ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
      ...(record.previousProviderSessionIds
        ? { previousProviderSessionIds: record.previousProviderSessionIds }
        : {}),
    },
  };
}

export function memoryChildPersistence(): ChildPersistence {
  const children = new Map<string, Map<string, PersistedChildSession>>();
  return {
    list(parentAppSessionId) {
      return [...(children.get(parentAppSessionId)?.values() ?? [])].map((child) =>
        structuredClone(child),
      );
    },
    get(parentAppSessionId, childSessionId) {
      const found = children.get(parentAppSessionId)?.get(childSessionId);
      return found ? structuredClone(found) : undefined;
    },
    upsert(child) {
      const group =
        children.get(child.parentAppSessionId) ?? new Map<string, PersistedChildSession>();
      group.set(child.childSessionId, structuredClone(child));
      children.set(child.parentAppSessionId, group);
      return true;
    },
  };
}

export function childPersistenceFromStore(
  store: Pick<SessionStore, 'upsertChild' | 'getChild' | 'listChildren'>,
): ChildPersistence {
  return {
    list(parentAppSessionId) {
      return store.listChildren(parentAppSessionId).map(persistedChildFromStored);
    },
    get(parentAppSessionId, childSessionId) {
      const stored = store.getChild(parentAppSessionId, childSessionId);
      return stored ? persistedChildFromStored(stored) : undefined;
    },
    upsert(child, parentBinding) {
      store.upsertChild(upsertChildInputFromPersisted(child, parentBinding));
      return true;
    },
  };
}

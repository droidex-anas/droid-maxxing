import type { ProviderBinding, SessionStore } from './persistence/SessionStore.js';
import { parseDroidResumeState } from './providers/droid/DroidModeMapping.js';
import type { ProviderRuntimeEvent } from './providers/providerEvents.js';

type BindingStore = Pick<SessionStore, 'get' | 'updateResumeState' | 'replaceProviderRuntime'>;

type BindingUpdated = Extract<ProviderRuntimeEvent, { type: 'binding.updated' }>;

export function persistBindingUpdated(
  store: BindingStore | undefined,
  event: BindingUpdated,
  current: ProviderBinding,
): ProviderBinding | undefined {
  if (event.providerInstanceId !== current.providerInstanceId) return undefined;
  if (event.runtimeGeneration !== current.runtimeGeneration) return undefined;
  const appSessionId = appSessionIdOf(event);
  const resumeState = event.binding.resumeState;
  const incomingNative = event.binding.providerSessionId;
  const resumeNative = parseDroidResumeState(resumeState)?.sessionId;
  const nativeReplacement =
    incomingNative !== undefined &&
    resumeNative === incomingNative &&
    incomingNative !== current.providerSessionId;

  if (store) {
    const stored = store.get(appSessionId);
    if (!stored) return undefined;
    if (stored.binding.providerInstanceId !== event.providerInstanceId) return undefined;
    if (stored.binding.runtimeGeneration !== event.runtimeGeneration) return undefined;
    try {
      if (nativeReplacement && incomingNative !== undefined) {
        return store.replaceProviderRuntime(
          appSessionId,
          event.runtimeGeneration,
          incomingNative,
          resumeState,
        ).binding;
      }
      return store.updateResumeState(appSessionId, event.runtimeGeneration, resumeState).binding;
    } catch {
      return undefined;
    }
  }

  if (nativeReplacement && incomingNative !== undefined) {
    return {
      ...current,
      providerSessionId: incomingNative,
      previousProviderSessionIds: current.providerSessionId
        ? [...current.previousProviderSessionIds, current.providerSessionId]
        : [...current.previousProviderSessionIds],
      resumeState,
      runtimeGeneration: current.runtimeGeneration + 1,
    };
  }
  return { ...current, resumeState };
}

function appSessionIdOf(event: ProviderRuntimeEvent): string {
  return event.target.kind === 'session'
    ? event.target.appSessionId
    : event.target.parentAppSessionId;
}

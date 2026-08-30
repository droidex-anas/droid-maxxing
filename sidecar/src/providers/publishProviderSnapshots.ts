import type { ProviderCapabilitySnapshot, ProviderWireSnapshot, ServerEvent } from '../protocol.js';
import type { ProviderDefinition, ProviderSnapshot } from './providerTypes.js';
import { UNAVAILABLE_PROVIDER_CAPABILITIES } from './unavailableProvider.js';
import type { ProviderRegistry } from './ProviderRegistry.js';

export function toProviderWireSnapshot(snapshot: ProviderSnapshot): ProviderWireSnapshot {
  return {
    definition: snapshot.definition,
    revision: snapshot.revision,
    readiness: snapshot.readiness,
    ...(snapshot.executable ? { executable: snapshot.executable } : {}),
    models: snapshot.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isDefault: model.isDefault,
      supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    })),
    capabilities: toCapabilitySnapshot(snapshot.capabilities),
    ...(snapshot.error
      ? {
          error: {
            code: snapshot.error.code,
            message: snapshot.error.message,
            recoveryAction: snapshot.error.recoveryAction,
          },
        }
      : {}),
  };
}

export function missingProviderWireSnapshot(definition: ProviderDefinition): ProviderWireSnapshot {
  return {
    definition,
    revision: 0,
    readiness: 'unavailable',
    models: [],
    capabilities: toCapabilitySnapshot(UNAVAILABLE_PROVIDER_CAPABILITIES),
    error: {
      code: 'unavailable_provider_instance',
      message: `${definition.displayName} has no discovery snapshot.`,
      recoveryAction: 'refresh',
    },
  };
}

export async function publishProviderSnapshots(input: {
  registry: Pick<ProviderRegistry, 'definitions' | 'refresh' | 'snapshot'>;
  emit: (event: Extract<ServerEvent, { type: 'providers.updated' }>) => void;
}): Promise<void> {
  const definitions = input.registry.definitions();
  await Promise.allSettled(
    definitions.map((definition) => input.registry.refresh(definition.providerInstanceId)),
  );
  input.emit({
    type: 'providers.updated',
    snapshots: definitions.map((definition) => {
      const snapshot = input.registry.snapshot(definition.providerInstanceId);
      return snapshot ? toProviderWireSnapshot(snapshot) : missingProviderWireSnapshot(definition);
    }),
  });
}

function toCapabilitySnapshot(
  capabilities: ProviderSnapshot['capabilities'],
): ProviderCapabilitySnapshot {
  return {
    modes: [...capabilities.modes],
    autonomyLevels: [...capabilities.autonomyLevels],
    modelChange: capabilities.modelChange,
    resume: capabilities.resume,
    steer: capabilities.steer,
    interrupt: capabilities.interrupt,
    approvals: capabilities.approvals,
    questions: capabilities.questions,
    planReview: capabilities.planReview,
    context: capabilities.context,
    compaction: capabilities.compaction,
    skills: capabilities.skills,
    slashCommands: capabilities.slashCommands,
    mcpUse: capabilities.mcpUse,
    mcpManagement: capabilities.mcpManagement,
    rewind: capabilities.rewind,
    fork: capabilities.fork,
    observationalTasks: capabilities.observationalTasks,
    addressableChildren: capabilities.addressableChildren,
    missionControl: capabilities.missionControl,
    browser: capabilities.browser,
    usageReporting: capabilities.usageReporting,
    reasoningStream: capabilities.reasoningStream,
  };
}

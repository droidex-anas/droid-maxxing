import type { Autonomy, SessionInteractionMode } from '../protocol.js';
import type {
  DroidSessionExtension,
  FactorySession,
} from '../providers/droid/DroidProviderSession.js';
import { createDroidSessionExtension } from '../providers/droid/DroidFactorySession.js';
import type { SessionConfiguration } from '../providers/providerIdentity.js';
import { ProviderContractError, type ProviderSession } from '../providers/providerTypes.js';
import { recoveryActionForProvider } from '../providers/droid/droidCapabilityGate.js';
import type { ChildParentLease, ChildRuntimeState } from '../ChildSessionState.js';
import type { ProviderInstanceId } from '../providers/providerIdentity.js';
import { liveBindingFromSummary } from '../sessionRegistryProjection.js';
import { StubProviderSession } from './stubProviderSession.js';

export function droidExtensionForFactory(session: FactorySession): DroidSessionExtension {
  return createDroidSessionExtension(
    () => session,
    () => {
      throw new Error('test factory cannot replace native session');
    },
  );
}

export function stubDroidProvider(
  session: FactorySession,
): ProviderSession & { droid: DroidSessionExtension; nativeSession: FactorySession } {
  let current = session;
  const provider = Object.assign(new StubProviderSession(session.sessionId), {
    droid: undefined as unknown as DroidSessionExtension,
  });
  Object.defineProperty(provider, 'nativeSession', {
    configurable: true,
    enumerable: true,
    get() {
      return current;
    },
  });
  provider.droid = createDroidSessionExtension(
    () => current,
    (next) => {
      current = next;
    },
  );
  return provider as ProviderSession & {
    droid: DroidSessionExtension;
    nativeSession: FactorySession;
  };
}

export function stubChildRuntime(
  session: FactorySession,
  generation = 1,
  lastUsedAt = 0,
): ChildRuntimeState {
  return {
    session,
    droid: droidExtensionForFactory(session),
    generation,
    lastUsedAt,
  };
}

export function droidParentLease(
  summary: ChildParentLease['summary'],
  session: ChildParentLease['session'] & FactorySession,
): ChildParentLease {
  return {
    summary,
    session,
    provider: stubDroidProvider(session),
    binding: summary.configuration
      ? liveBindingFromSummary(summary)
      : {
          providerDriverKind: 'droid',
          providerInstanceId: 'droid',
          previousProviderSessionIds: [],
          runtimeGeneration: 0,
        },
    mcpConfigs: [],
  };
}

export function cursorSessionConfiguration(input: {
  modelId: string;
  interactionMode?: SessionInteractionMode;
  autonomy?: Autonomy;
}): SessionConfiguration {
  return {
    providerSelection: {
      providerInstanceId: 'cursor',
      modelId: input.modelId,
      options: {},
    },
    interactionMode: input.interactionMode ?? 'auto',
    autonomy: input.autonomy ?? 'low',
  };
}

export function assertUnsupportedCapability(
  error: unknown,
  expected: {
    providerInstanceId: ProviderInstanceId;
    operation: string;
    capability: string;
  },
): asserts error is ProviderContractError {
  if (!(error instanceof ProviderContractError)) {
    throw new Error(`expected ProviderContractError, got ${String(error)}`);
  }
  if (error.code !== 'unsupported_capability') {
    throw new Error(`expected unsupported_capability, got ${error.code}`);
  }
  if (error.providerInstanceId !== expected.providerInstanceId) {
    throw new Error(
      `expected provider ${expected.providerInstanceId}, got ${error.providerInstanceId}`,
    );
  }
  const recovery =
    expected.providerInstanceId === 'droid'
      ? 'retry_session'
      : recoveryActionForProvider(expected.providerInstanceId);
  if (error.recoveryAction !== recovery) {
    throw new Error(`expected recovery ${recovery}, got ${error.recoveryAction}`);
  }
  if (!error.message.includes(expected.operation) || !error.message.includes(expected.capability)) {
    throw new Error(`expected ${expected.operation}/${expected.capability} in ${error.message}`);
  }
}

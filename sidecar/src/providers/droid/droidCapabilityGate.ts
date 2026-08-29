import type { LiveSession } from '../../SessionLifecycle.js';
import type { ProviderInstanceId } from '../providerIdentity.js';
import type { ProviderRecoveryAction } from '../providerErrors.js';
import type { BooleanProviderCapability } from '../ProviderRegistry.js';
import {
  createProviderContractError,
  type ProviderCapabilities,
  type ProviderContractError,
  type ProviderSession,
} from '../providerTypes.js';
import { droidCapabilities } from './DroidModeMapping.js';
import type { DroidSessionExtension } from './DroidFactorySession.js';

export type GatedDroidCapability = BooleanProviderCapability | 'modelChange';

export type DroidCapabilityLive = {
  provider: ProviderSession;
  binding: { providerInstanceId: ProviderInstanceId };
};

export function hasDroidExtension(
  provider: ProviderSession,
): provider is ProviderSession & { readonly droid: DroidSessionExtension } {
  return (
    typeof (provider as { droid?: { compactSession?: unknown } }).droid?.compactSession ===
    'function'
  );
}

export function recoveryActionForProvider(
  providerInstanceId: ProviderInstanceId,
): ProviderRecoveryAction {
  switch (providerInstanceId) {
    case 'droid':
      return 'open_droid_setup';
    case 'codex':
      return 'open_codex_setup';
    case 'claude':
      return 'open_claude_setup';
    case 'cursor':
      return 'open_cursor_setup';
    case 'grok':
      return 'open_grok_setup';
  }
}

export function unsupportedDroidCapabilityError(
  providerInstanceId: ProviderInstanceId,
  operation: string,
  capability: string,
): ProviderContractError {
  return createProviderContractError(
    providerInstanceId,
    'unsupported_capability',
    `${operation} requires ${capability} on provider ${providerInstanceId}`,
    providerInstanceId === 'droid'
      ? 'retry_session'
      : recoveryActionForProvider(providerInstanceId),
  );
}

export function capabilityEnabled(
  capabilities: ProviderCapabilities | undefined,
  capability: GatedDroidCapability,
): boolean {
  if (!capabilities) return false;
  if (capability === 'modelChange') return capabilities.modelChange !== 'unsupported';
  return capabilities[capability] === true;
}

export function resolveDroidCapabilities(
  providerInstanceId: ProviderInstanceId,
  provider: ProviderSession | undefined,
  snapshot: ProviderCapabilities | undefined,
): ProviderCapabilities | undefined {
  if (snapshot) return snapshot;
  if (providerInstanceId === 'droid' && provider && hasDroidExtension(provider)) {
    return droidCapabilities();
  }
  if (providerInstanceId === 'droid' && !provider) return droidCapabilities();
  return undefined;
}

export function requireDroidExtension(
  provider: ProviderSession,
  operation: string,
  providerInstanceId: ProviderInstanceId,
): DroidSessionExtension {
  if (hasDroidExtension(provider)) return provider.droid;
  throw unsupportedDroidCapabilityError(providerInstanceId, operation, 'droid');
}

export function requireDroidCapability(
  live: DroidCapabilityLive,
  capability: GatedDroidCapability,
  operation: string,
  capabilities?: ProviderCapabilities,
): DroidSessionExtension {
  const providerInstanceId = live.binding.providerInstanceId;
  const resolved = resolveDroidCapabilities(providerInstanceId, live.provider, capabilities);
  if (!capabilityEnabled(resolved, capability)) {
    throw unsupportedDroidCapabilityError(providerInstanceId, operation, capability);
  }
  return requireDroidExtension(live.provider, operation, providerInstanceId);
}

export async function interruptIdleDroidSession(live: LiveSession): Promise<void> {
  requireDroidCapability(live, 'interrupt', 'interrupt');
  await live.session.interrupt();
}

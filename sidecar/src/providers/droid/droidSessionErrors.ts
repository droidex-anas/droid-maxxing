import type { ProviderError } from '../providerErrors.js';
import { createProviderContractError, ProviderContractError } from '../providerTypes.js';

export function droidError(
  code: ProviderError['code'],
  message: string,
  recoveryAction: ProviderError['recoveryAction'],
): ProviderContractError {
  return createProviderContractError('droid', code, message, recoveryAction);
}

export function mapSessionError(error: unknown): ProviderError {
  if (error instanceof ProviderContractError) return error.toProviderError();
  const raw = error instanceof Error ? error.message : 'Droid turn failed.';
  const message = /secret|api[_-]?key|authorization/i.test(raw) ? 'Droid turn failed.' : raw;
  return droidError('incompatible_provider_protocol', message, 'retry_session').toProviderError();
}

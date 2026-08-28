import {
  parseProviderError,
  type ProviderError,
  type ProviderErrorCode,
  type ProviderRecoveryAction,
} from '../providerErrors.js';
import type { ProviderInstanceId } from '../providerIdentity.js';
import { AcpProcessSpawnFailure } from './acpProcess.js';

export class AcpConnectionError extends Error implements ProviderError {
  readonly code: ProviderErrorCode;
  readonly providerInstanceId: ProviderInstanceId;
  readonly recoveryAction: ProviderRecoveryAction;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = 'AcpConnectionError';
    this.code = error.code;
    this.providerInstanceId = error.providerInstanceId;
    this.recoveryAction = error.recoveryAction;
  }

  toProviderError(): ProviderError {
    return {
      code: this.code,
      providerInstanceId: this.providerInstanceId,
      message: this.message,
      recoveryAction: this.recoveryAction,
    };
  }
}

export function createAcpConnectionError(
  providerInstanceId: ProviderInstanceId,
  code: ProviderErrorCode,
  message: string,
): AcpConnectionError {
  return new AcpConnectionError(
    parseProviderError({
      code,
      providerInstanceId,
      message,
      recoveryAction: recoveryActionFor(code, providerInstanceId),
    }),
  );
}

export function mapSpawnFailure(
  providerInstanceId: ProviderInstanceId,
  error: unknown,
): AcpConnectionError {
  const missing = error instanceof AcpProcessSpawnFailure && error.reason === 'missing_executable';
  return createAcpConnectionError(
    providerInstanceId,
    missing ? 'missing_executable' : 'provider_process_exited',
    missing ? 'ACP peer executable was not found' : 'ACP peer process failed to start',
  );
}

function recoveryActionFor(
  code: ProviderErrorCode,
  providerInstanceId: ProviderInstanceId,
): ProviderRecoveryAction {
  if (code === 'missing_executable' || code === 'unauthenticated_provider') {
    if (providerInstanceId === 'grok') {
      return 'open_grok_setup';
    }
    if (providerInstanceId === 'cursor') {
      return 'open_cursor_setup';
    }
    return 'refresh';
  }
  if (code === 'provider_process_exited') {
    return 'retry_session';
  }
  if (code === 'stale_provider_operation') {
    return 'close_session';
  }
  return 'refresh';
}

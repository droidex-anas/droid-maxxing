import { z } from 'zod';

import { providerInstanceIdSchema, type ProviderInstanceId } from './providerIdentity.js';

export type ProviderErrorCode =
  | 'invalid_provider_configuration'
  | 'missing_executable'
  | 'unauthenticated_provider'
  | 'unsupported_provider_version'
  | 'unavailable_provider_instance'
  | 'unsupported_capability'
  | 'native_session_start_failed'
  | 'incompatible_provider_protocol'
  | 'provider_process_exited'
  | 'interaction_cancelled'
  | 'stale_provider_operation'
  | 'canonical_persistence_unavailable';

export type ProviderRecoveryAction =
  | 'refresh'
  | 'open_droid_setup'
  | 'open_codex_setup'
  | 'open_claude_setup'
  | 'reset_canonical_state'
  | 'retry_session'
  | 'close_session';

export interface ProviderError {
  code: ProviderErrorCode;
  providerInstanceId: ProviderInstanceId;
  message: string;
  recoveryAction: ProviderRecoveryAction;
}

export const MAX_PROVIDER_ERROR_MESSAGE_CHARS = 4096;

const PROVIDER_ERROR_CODES = [
  'invalid_provider_configuration',
  'missing_executable',
  'unauthenticated_provider',
  'unsupported_provider_version',
  'unavailable_provider_instance',
  'unsupported_capability',
  'native_session_start_failed',
  'incompatible_provider_protocol',
  'provider_process_exited',
  'interaction_cancelled',
  'stale_provider_operation',
  'canonical_persistence_unavailable',
] as const satisfies readonly ProviderErrorCode[];

const PROVIDER_RECOVERY_ACTIONS = [
  'refresh',
  'open_droid_setup',
  'open_codex_setup',
  'open_claude_setup',
  'reset_canonical_state',
  'retry_session',
  'close_session',
] as const satisfies readonly ProviderRecoveryAction[];

export const providerErrorCodeSchema = z.enum(PROVIDER_ERROR_CODES);
export const providerRecoveryActionSchema = z.enum(PROVIDER_RECOVERY_ACTIONS);

export function sanitizeProviderErrorMessage(message: string): string {
  return message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

const providerErrorMessageSchema = z
  .string()
  .min(1)
  .max(MAX_PROVIDER_ERROR_MESSAGE_CHARS)
  .transform(sanitizeProviderErrorMessage)
  .refine((message) => message.length > 0, 'message must not be empty after sanitization');

export const providerErrorSchema = z
  .object({
    code: providerErrorCodeSchema,
    providerInstanceId: providerInstanceIdSchema,
    message: providerErrorMessageSchema,
    recoveryAction: providerRecoveryActionSchema,
  })
  .strict();

export function parseProviderError(value: unknown): ProviderError {
  return providerErrorSchema.parse(value);
}

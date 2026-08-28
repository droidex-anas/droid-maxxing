import { z } from 'zod';

import type { Autonomy, ReasoningEffort, SessionInteractionMode } from '../protocol.js';

export type ProviderDriverKind = 'droid' | 'codex' | 'claude';
export type ProviderInstanceId = 'droid' | 'codex' | 'claude';

export type SessionTarget =
  | { kind: 'session'; appSessionId: string }
  | { kind: 'child'; parentAppSessionId: string; childSessionId: string };

export interface ProviderSelection {
  providerInstanceId: ProviderInstanceId;
  modelId: string;
  options: Record<string, string | number | boolean>;
}

export interface SessionConfiguration {
  providerSelection: ProviderSelection;
  interactionMode: SessionInteractionMode;
  autonomy: Autonomy;
}

export interface DroidAgentConfiguration {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface DroidMissionConfiguration {
  worker: DroidAgentConfiguration;
  validator: DroidAgentConfiguration;
}

export interface ProviderBinding {
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
}

export const MAX_BOUNDED_ID_CHARS = 256;
export const MAX_MODEL_ID_CHARS = 256;

const SESSION_INTERACTION_MODES = [
  'auto',
  'spec',
  'agi',
] as const satisfies readonly SessionInteractionMode[];
const AUTONOMY_LEVELS = ['off', 'low', 'medium', 'high'] as const satisfies readonly Autonomy[];
const REASONING_EFFORTS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'dynamic',
] as const satisfies readonly ReasoningEffort[];

export const providerDriverKindSchema = z.enum(['droid', 'codex', 'claude']);
export const providerInstanceIdSchema = z.enum(['droid', 'codex', 'claude']);
export const sessionInteractionModeSchema = z.enum(SESSION_INTERACTION_MODES);
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

const boundedIdSchema = z.string().trim().min(1).max(MAX_BOUNDED_ID_CHARS);
const modelIdSchema = z.string().trim().min(1).max(MAX_MODEL_ID_CHARS);
const providerOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const providerBindingSchema = z
  .object({
    providerDriverKind: providerDriverKindSchema,
    providerInstanceId: providerInstanceIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerDriverKind !== value.providerInstanceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'providerDriverKind must match providerInstanceId for v1 bindings',
      });
    }
  });

export const providerSelectionSchema = z
  .object({
    providerInstanceId: providerInstanceIdSchema,
    modelId: modelIdSchema,
    options: z.record(providerOptionValueSchema),
  })
  .strict();

export const sessionConfigurationSchema = z
  .object({
    providerSelection: providerSelectionSchema,
    interactionMode: sessionInteractionModeSchema,
    autonomy: autonomySchema,
  })
  .strict();

export const sessionTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('session'),
      appSessionId: boundedIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('child'),
      parentAppSessionId: boundedIdSchema,
      childSessionId: boundedIdSchema,
    })
    .strict(),
]);

export const droidAgentConfigurationSchema = z
  .object({
    modelId: modelIdSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();

export const droidMissionConfigurationSchema = z
  .object({
    worker: droidAgentConfigurationSchema,
    validator: droidAgentConfigurationSchema,
  })
  .strict();

const PROVIDER_DRIVER_BY_INSTANCE: Record<ProviderInstanceId, ProviderDriverKind> = {
  droid: 'droid',
  codex: 'codex',
  claude: 'claude',
};

export function providerDriverKindForInstance(
  providerInstanceId: ProviderInstanceId,
): ProviderDriverKind {
  return PROVIDER_DRIVER_BY_INSTANCE[providerInstanceId];
}

export function providerBindingForInstance(
  providerInstanceId: ProviderInstanceId,
): ProviderBinding {
  return {
    providerDriverKind: providerDriverKindForInstance(providerInstanceId),
    providerInstanceId,
  };
}

export function providerSelectionsEqual(a: ProviderSelection, b: ProviderSelection): boolean {
  if (a.providerInstanceId !== b.providerInstanceId) {
    return false;
  }
  if (a.modelId !== b.modelId) {
    return false;
  }
  const aKeys = Object.keys(a.options).sort();
  const bKeys = Object.keys(b.options).sort();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (a.options[key] !== b.options[key]) {
      return false;
    }
  }
  return true;
}

export function parseProviderBinding(value: unknown): ProviderBinding {
  return providerBindingSchema.parse(value);
}

export function parseProviderSelection(value: unknown): ProviderSelection {
  return providerSelectionSchema.parse(value);
}

export function parseSessionConfiguration(value: unknown): SessionConfiguration {
  return sessionConfigurationSchema.parse(value);
}

export function parseSessionTarget(value: unknown): SessionTarget {
  return sessionTargetSchema.parse(value);
}

export function parseDroidAgentConfiguration(value: unknown): DroidAgentConfiguration {
  return droidAgentConfigurationSchema.parse(value);
}

export function parseDroidMissionConfiguration(value: unknown): DroidMissionConfiguration {
  return droidMissionConfigurationSchema.parse(value);
}

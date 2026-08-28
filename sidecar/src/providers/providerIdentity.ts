import { z } from 'zod';

import type { Autonomy, ReasoningEffort, SessionInteractionMode } from '../protocol.js';

export type ProviderDriverKind = 'droid' | 'codex' | 'claude' | 'cursor' | 'grok';
export type ProviderInstanceId = 'droid' | 'codex' | 'claude' | 'cursor' | 'grok';

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

const MAX_BOUNDED_ID_CHARS = 256;
const MAX_MODEL_ID_CHARS = 256;

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

type AssertNoMissing<TUnion, TListed extends TUnion> =
  Exclude<TUnion, TListed> extends never
    ? true
    : ['missing enum members', Exclude<TUnion, TListed>];

const _sessionInteractionModesComplete = true satisfies AssertNoMissing<
  SessionInteractionMode,
  (typeof SESSION_INTERACTION_MODES)[number]
>;
const _autonomyLevelsComplete = true satisfies AssertNoMissing<
  Autonomy,
  (typeof AUTONOMY_LEVELS)[number]
>;
const _reasoningEffortsComplete = true satisfies AssertNoMissing<
  ReasoningEffort,
  (typeof REASONING_EFFORTS)[number]
>;

export const providerDriverKindSchema = z.enum(['droid', 'codex', 'claude', 'cursor', 'grok']);
export const providerInstanceIdSchema = z.enum(['droid', 'codex', 'claude', 'cursor', 'grok']);
export const sessionInteractionModeSchema = z.enum(SESSION_INTERACTION_MODES);
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

const boundedIdSchema = z
  .string()
  .min(1)
  .max(MAX_BOUNDED_ID_CHARS)
  .refine((value) => value === value.trim(), 'id must not have leading or trailing whitespace');
const modelIdSchema = z
  .string()
  .min(1)
  .max(MAX_MODEL_ID_CHARS)
  .refine(
    (value) => value === value.trim(),
    'modelId must not have leading or trailing whitespace',
  );
const providerOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

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
  cursor: 'cursor',
  grok: 'grok',
};

export function providerDriverKindForInstance(
  providerInstanceId: ProviderInstanceId,
): ProviderDriverKind {
  return PROVIDER_DRIVER_BY_INSTANCE[providerInstanceId];
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

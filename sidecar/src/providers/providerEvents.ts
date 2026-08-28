import { z } from 'zod';

import type {
  BrowserTranscriptReference,
  ChildSessionSummary,
  ContextBreakdownSnapshot,
  ContextStatsSnapshot,
  TranscriptEvent,
} from '../protocol.js';
import { providerErrorSchema, type ProviderError } from './providerErrors.js';
import {
  autonomySchema,
  parseSessionTarget,
  providerDriverKindSchema,
  providerInstanceIdSchema,
  reasoningEffortSchema,
  sessionTargetSchema,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SessionTarget,
} from './providerIdentity.js';
import { createProviderContractError, type ProviderTurnSettlement } from './providerTypes.js';

const MAX_DIAGNOSTIC_ID_CHARS = 256;
const MAX_WARNING_MESSAGE_CHARS = 4096;

export interface ProviderRuntimeEventBase {
  eventId: string;
  target: SessionTarget;
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  runtimeGeneration: number;
  createdAt: number;
  turnId?: string;
  nativeCorrelation?: {
    sessionId?: string;
    turnId?: string;
    itemId?: string;
  };
}

export type ProviderSessionEffect =
  | { kind: 'context'; stats: ContextStatsSnapshot }
  | { kind: 'resume_state'; resumeState: unknown }
  | {
      kind: 'compaction';
      compactType: 'auto' | 'manual';
      removedCount: number;
    }
  | {
      kind: 'observational_task';
      taskId: string;
      label: string;
      status: 'running' | 'completed' | 'failed';
      preview?: string;
    }
  | { kind: 'child_upsert'; child: ChildSessionSummary };

export type ProviderRuntimeEvent = ProviderRuntimeEventBase &
  (
    | {
        type: 'transcript';
        event: Omit<TranscriptEvent, 'id' | 'appSessionId' | 'sourceSessionId' | 'seq' | 'ts'>;
      }
    | {
        type: 'usage';
        inputTokens: number;
        outputTokens: number;
        contextTokens?: number;
      }
    | { type: 'session.effect'; effect: ProviderSessionEffect }
    | {
        type: 'binding.updated';
        binding: { providerSessionId?: string; resumeState: unknown };
      }
    | { type: 'turn.settled'; settlement: ProviderTurnSettlement }
    | { type: 'warning'; message: string }
    | { type: 'error'; error: ProviderError }
  );

export type ProviderEventSink = (event: ProviderRuntimeEvent) => void;

const boundedDiagnosticIdSchema = z
  .string()
  .min(1)
  .max(MAX_DIAGNOSTIC_ID_CHARS)
  .refine((value) => value === value.trim(), 'id must not have leading or trailing whitespace');

const nativeCorrelationSchema = z
  .object({
    sessionId: boundedDiagnosticIdSchema.optional(),
    turnId: boundedDiagnosticIdSchema.optional(),
    itemId: boundedDiagnosticIdSchema.optional(),
  })
  .strict();

const runtimeEventBaseSchema = z
  .object({
    eventId: boundedDiagnosticIdSchema,
    target: sessionTargetSchema,
    providerDriverKind: providerDriverKindSchema,
    providerInstanceId: providerInstanceIdSchema,
    runtimeGeneration: z.number().int().nonnegative(),
    createdAt: z.number().finite(),
    turnId: boundedDiagnosticIdSchema.optional(),
    nativeCorrelation: nativeCorrelationSchema.optional(),
  })
  .strict();

const sessionRoleSchema = z.enum(['primary', 'worker', 'validator']);
const transcriptKindSchema = z.enum([
  'text',
  'thinking',
  'tool_call',
  'tool_result',
  'error',
  'status',
  'compaction',
]);
const browserRefKindSchema = z.enum(['element', 'region', 'text']);

const browserTranscriptReferenceSchema: z.ZodType<BrowserTranscriptReference> = z
  .object({
    id: boundedDiagnosticIdSchema,
    label: z.string().min(1),
    kind: browserRefKindSchema,
    url: z.string().optional(),
    selector: z.string().optional(),
    imageDataUrl: z.string().optional(),
  })
  .strict();

const transcriptPayloadSchema = z
  .object({
    role: sessionRoleSchema,
    endTs: z.number().finite().optional(),
    kind: transcriptKindSchema,
    text: z.string().optional(),
    toolName: z.string().optional(),
    toolArgs: z.unknown().optional(),
    toolUseId: z.string().optional(),
    isError: z.boolean().optional(),
    removedCount: z.number().int().nonnegative().optional(),
    author: z.literal('user').optional(),
    skills: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    browserRefs: z.array(browserTranscriptReferenceSchema).optional(),
    steered: z.boolean().optional(),
    compactType: z.enum(['auto', 'manual']).optional(),
  })
  .strict();

const contextBreakdownCategorySchema = z
  .object({
    name: z.string().min(1),
    tokens: z.number().finite(),
    colorKey: z.string().optional(),
  })
  .strict();

const contextBreakdownSchema: z.ZodType<ContextBreakdownSnapshot> = z
  .object({
    modelId: z.string().optional(),
    modelDisplayName: z.string().optional(),
    contextBudget: z.number().finite(),
    usedTokens: z.number().finite(),
    freeTokens: z.number().finite(),
    categories: z.array(contextBreakdownCategorySchema),
  })
  .strict();

const contextStatsSchema: z.ZodType<ContextStatsSnapshot> = z
  .object({
    used: z.number().finite(),
    remaining: z.number().finite(),
    limit: z.number().finite(),
    accuracy: z.enum(['exact', 'estimated']),
    updatedAt: z.string().min(1),
    breakdown: contextBreakdownSchema.optional(),
    compactions: z.number().int().nonnegative().optional(),
  })
  .strict();

const childActivitySchema = z
  .object({
    phase: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();

const childSpawnLinkSchema = z
  .object({
    kind: z.enum(['tool-use', 'spawn']),
    id: boundedDiagnosticIdSchema,
  })
  .strict();

const childSessionSummarySchema: z.ZodType<ChildSessionSummary> = z
  .object({
    parentAppSessionId: boundedDiagnosticIdSchema,
    childSessionId: boundedDiagnosticIdSchema,
    role: z.enum(['worker', 'validator']),
    status: z.enum(['pending', 'running', 'paused', 'completed']),
    label: z.string().optional(),
    prompt: z.string().optional(),
    modelId: z.string().min(1),
    reasoningEffort: reasoningEffortSchema.optional(),
    autonomy: autonomySchema.optional(),
    spawnLink: childSpawnLinkSchema.optional(),
    transcriptAvailable: z.boolean(),
    startedAt: z.number().finite().optional(),
    streamFidelity: z.enum(['token', 'tool', 'state']),
    activity: childActivitySchema.optional(),
    queued: z.boolean().optional(),
  })
  .strict();

const opaqueResumeStateSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);

const sessionEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), stats: contextStatsSchema }).strict(),
  z.object({ kind: z.literal('resume_state'), resumeState: opaqueResumeStateSchema }).strict(),
  z
    .object({
      kind: z.literal('compaction'),
      compactType: z.enum(['auto', 'manual']),
      removedCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observational_task'),
      taskId: boundedDiagnosticIdSchema,
      label: z.string().min(1),
      status: z.enum(['running', 'completed', 'failed']),
      preview: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('child_upsert'), child: childSessionSummarySchema }).strict(),
]);

const turnSettlementSchema: z.ZodType<ProviderTurnSettlement> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed') }).strict(),
  z.object({ status: z.literal('failed'), error: providerErrorSchema }).strict(),
  z.object({ status: z.literal('interrupted') }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
]);

const bindingSchema = z
  .object({
    providerSessionId: boundedDiagnosticIdSchema.optional(),
    resumeState: opaqueResumeStateSchema,
  })
  .strict();

const warningMessageSchema = z
  .string()
  .min(1)
  .max(MAX_WARNING_MESSAGE_CHARS)
  .refine(
    (value) => value === value.trim(),
    'message must not have leading or trailing whitespace',
  );

const transcriptEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('transcript'),
  event: transcriptPayloadSchema,
});
const usageEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
});
const sessionEffectEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('session.effect'),
  effect: sessionEffectSchema,
});
const bindingUpdatedEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('binding.updated'),
  binding: bindingSchema,
});
const turnSettledEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('turn.settled'),
  settlement: turnSettlementSchema,
});
const warningEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('warning'),
  message: warningMessageSchema,
});
const errorEventSchema = runtimeEventBaseSchema.extend({
  type: z.literal('error'),
  error: providerErrorSchema,
});

export const providerRuntimeEventSchema = z.discriminatedUnion('type', [
  transcriptEventSchema,
  usageEventSchema,
  sessionEffectEventSchema,
  bindingUpdatedEventSchema,
  turnSettledEventSchema,
  warningEventSchema,
  errorEventSchema,
]);

export function parseProviderRuntimeEvent(value: unknown): ProviderRuntimeEvent {
  return providerRuntimeEventSchema.parse(value);
}

export function serializedProviderEventBytes(event: ProviderRuntimeEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

export type ProviderEventAdmissionLive = {
  target: SessionTarget;
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  runtimeGeneration: number;
  settledTurnIds: ReadonlySet<string>;
};

export type ProviderEventRejection =
  | 'stale_generation'
  | 'wrong_driver'
  | 'wrong_instance'
  | 'wrong_session'
  | 'turn_already_settled';

export function sessionTargetsEqual(a: SessionTarget, b: SessionTarget): boolean {
  if (a.kind === 'session' && b.kind === 'session') {
    return a.appSessionId === b.appSessionId;
  }
  if (a.kind === 'child' && b.kind === 'child') {
    return a.parentAppSessionId === b.parentAppSessionId && a.childSessionId === b.childSessionId;
  }
  return false;
}

export function admitProviderRuntimeEvent(
  event: ProviderRuntimeEvent,
  live: ProviderEventAdmissionLive,
): { ok: true } | { ok: false; reason: ProviderEventRejection } {
  if (event.runtimeGeneration !== live.runtimeGeneration) {
    return { ok: false, reason: 'stale_generation' };
  }
  if (event.providerDriverKind !== live.providerDriverKind) {
    return { ok: false, reason: 'wrong_driver' };
  }
  if (event.providerInstanceId !== live.providerInstanceId) {
    return { ok: false, reason: 'wrong_instance' };
  }
  if (!sessionTargetsEqual(event.target, live.target)) {
    return { ok: false, reason: 'wrong_session' };
  }
  if (event.turnId !== undefined && live.settledTurnIds.has(event.turnId)) {
    return { ok: false, reason: 'turn_already_settled' };
  }
  return { ok: true };
}

export function decodeAdmittedProviderRuntimeEvent(
  value: unknown,
  live: ProviderEventAdmissionLive,
): ProviderRuntimeEvent {
  const event = parseProviderRuntimeEvent(value);
  parseSessionTarget(event.target);
  const admission = admitProviderRuntimeEvent(event, live);
  if (!admission.ok) {
    throw createProviderContractError(
      live.providerInstanceId,
      admission.reason === 'stale_generation'
        ? 'stale_provider_operation'
        : 'invalid_provider_configuration',
      `provider event rejected: ${admission.reason}`,
      admission.reason === 'stale_generation' ? 'retry_session' : 'close_session',
    );
  }
  return event;
}

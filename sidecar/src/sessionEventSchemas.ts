import { z } from 'zod';

import type {
  BrowserTranscriptReference,
  ChildSessionSummary,
  ContextBreakdownSnapshot,
  ContextStatsSnapshot,
} from './protocol.js';
import { providerErrorSchema } from './providers/providerErrors.js';
import {
  autonomySchema,
  providerDriverKindSchema,
  providerInstanceIdSchema,
  reasoningEffortSchema,
  sessionTargetSchema,
} from './providers/providerIdentity.js';
import type {
  CanonicalEvent,
  CanonicalEventPayload,
  CanonicalSessionEffect,
  CanonicalTranscriptPayload,
  CanonicalTurnSettlement,
} from './sessionEvents.js';

const MAX_BOUNDED_ID_CHARS = 256;
const MAX_WARNING_MESSAGE_CHARS = 4096;

const boundedIdSchema = z
  .string()
  .min(1)
  .max(MAX_BOUNDED_ID_CHARS)
  .refine((value) => value === value.trim(), 'id must not have leading or trailing whitespace');

const nativeCorrelationSchema = z
  .object({
    sessionId: boundedIdSchema.optional(),
    turnId: boundedIdSchema.optional(),
    itemId: boundedIdSchema.optional(),
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

const browserTranscriptReferenceSchema: z.ZodType<BrowserTranscriptReference> = z
  .object({
    id: boundedIdSchema,
    label: z.string().min(1),
    kind: z.enum(['element', 'region', 'text']),
    url: z.string().optional(),
    selector: z.string().optional(),
    imageDataUrl: z.string().optional(),
  })
  .strict();

const canonicalTranscriptPayloadSchema: z.ZodType<CanonicalTranscriptPayload> = z
  .object({
    role: sessionRoleSchema,
    kind: transcriptKindSchema,
    endAt: z.number().finite().optional(),
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

const childSessionSummarySchema: z.ZodType<ChildSessionSummary> = z
  .object({
    parentAppSessionId: boundedIdSchema,
    childSessionId: boundedIdSchema,
    role: z.enum(['worker', 'validator']),
    status: z.enum(['pending', 'running', 'paused', 'completed']),
    label: z.string().optional(),
    prompt: z.string().optional(),
    modelId: z.string().min(1),
    reasoningEffort: reasoningEffortSchema.optional(),
    autonomy: autonomySchema.optional(),
    spawnLink: z
      .object({
        kind: z.enum(['tool-use', 'spawn']),
        id: boundedIdSchema,
      })
      .strict()
      .optional(),
    transcriptAvailable: z.boolean(),
    startedAt: z.number().finite().optional(),
    streamFidelity: z.enum(['token', 'tool', 'state']),
    activity: z
      .object({
        phase: z.string().optional(),
        preview: z.string().optional(),
      })
      .strict()
      .optional(),
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

const canonicalSessionEffectSchema: z.ZodType<CanonicalSessionEffect> = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('context'), stats: contextStatsSchema }).strict(),
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
        taskId: boundedIdSchema,
        label: z.string().min(1),
        status: z.enum(['running', 'completed', 'failed']),
        preview: z.string().optional(),
      })
      .strict(),
    z.object({ kind: z.literal('child_upsert'), child: childSessionSummarySchema }).strict(),
  ],
);

const turnSettlementSchema: z.ZodType<CanonicalTurnSettlement> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed') }).strict(),
  z.object({ status: z.literal('failed'), error: providerErrorSchema }).strict(),
  z.object({ status: z.literal('interrupted') }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
]);

const warningMessageSchema = z
  .string()
  .min(1)
  .max(MAX_WARNING_MESSAGE_CHARS)
  .refine(
    (value) => value === value.trim(),
    'message must not have leading or trailing whitespace',
  );

const requestLifecycleSchema = z.object({
  requestId: boundedIdSchema,
  status: z.enum(['requested', 'settled']),
});

export const canonicalEventPayloadSchema: z.ZodType<CanonicalEventPayload> = z.discriminatedUnion(
  'type',
  [
    z
      .object({
        type: z.literal('session.lifecycle'),
        status: z.enum(['started', 'resumed', 'closed', 'failed']),
      })
      .strict(),
    z.object({ type: z.literal('turn.started') }).strict(),
    z
      .object({ type: z.literal('transcript'), transcript: canonicalTranscriptPayloadSchema })
      .strict(),
    z
      .object({
        type: z.literal('usage'),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        contextTokens: z.number().int().nonnegative().optional(),
      })
      .strict(),
    requestLifecycleSchema.extend({ type: z.literal('approval.lifecycle') }).strict(),
    requestLifecycleSchema.extend({ type: z.literal('question.lifecycle') }).strict(),
    requestLifecycleSchema.extend({ type: z.literal('plan_review.lifecycle') }).strict(),
    z.object({ type: z.literal('session.effect'), effect: canonicalSessionEffectSchema }).strict(),
    z
      .object({
        type: z.literal('binding.updated'),
        resumeState: opaqueResumeStateSchema,
        replacementProviderSessionId: boundedIdSchema.optional(),
      })
      .strict(),
    z.object({ type: z.literal('turn.settled'), settlement: turnSettlementSchema }).strict(),
    z.object({ type: z.literal('warning'), message: warningMessageSchema }).strict(),
    z.object({ type: z.literal('error'), error: providerErrorSchema }).strict(),
  ],
);

export const canonicalEventSchema: z.ZodType<CanonicalEvent> = z
  .object({
    eventId: boundedIdSchema,
    target: sessionTargetSchema,
    providerDriverKind: providerDriverKindSchema,
    providerInstanceId: providerInstanceIdSchema,
    runtimeGeneration: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    turnId: boundedIdSchema.optional(),
    nativeCorrelation: nativeCorrelationSchema.optional(),
    payload: canonicalEventPayloadSchema,
  })
  .strict();

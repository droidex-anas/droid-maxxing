import type {
  BrowserTranscriptReference,
  ChildSessionSummary,
  ContextStatsSnapshot,
  SessionRole,
  TranscriptEvent,
} from './protocol.js';
import type { ProviderError } from './providers/providerErrors.js';
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  SessionTarget,
} from './providers/providerIdentity.js';
import { canonicalEventPayloadSchema, canonicalEventSchema } from './sessionEventSchemas.js';

export interface CanonicalTranscriptPayload {
  role: SessionRole;
  kind: TranscriptEvent['kind'];
  endAt?: number;
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolUseId?: string;
  isError?: boolean;
  removedCount?: number;
  author?: 'user';
  skills?: string[];
  files?: string[];
  browserRefs?: BrowserTranscriptReference[];
  steered?: boolean;
  compactType?: 'auto' | 'manual';
}

export type CanonicalTurnSettlement =
  | { status: 'completed' }
  | { status: 'failed'; error: ProviderError }
  | { status: 'interrupted' | 'cancelled' };

export type CanonicalSessionEffect =
  | { kind: 'context'; stats: ContextStatsSnapshot }
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

export type CanonicalEventPayload =
  | { type: 'session.lifecycle'; status: 'started' | 'resumed' | 'closed' | 'failed' }
  | { type: 'turn.started' }
  | { type: 'transcript'; transcript: CanonicalTranscriptPayload }
  | { type: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number }
  | { type: 'approval.lifecycle'; requestId: string; status: 'requested' | 'settled' }
  | { type: 'question.lifecycle'; requestId: string; status: 'requested' | 'settled' }
  | { type: 'plan_review.lifecycle'; requestId: string; status: 'requested' | 'settled' }
  | { type: 'session.effect'; effect: CanonicalSessionEffect }
  | {
      type: 'binding.updated';
      resumeState: unknown;
      replacementProviderSessionId?: string;
    }
  | { type: 'turn.settled'; settlement: CanonicalTurnSettlement }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: ProviderError };

export interface CanonicalNativeCorrelation {
  sessionId?: string;
  turnId?: string;
  itemId?: string;
}

export interface CanonicalEvent {
  eventId: string;
  target: SessionTarget;
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  runtimeGeneration: number;
  createdAt: number;
  turnId?: string;
  nativeCorrelation?: CanonicalNativeCorrelation;
  payload: CanonicalEventPayload;
}

export interface PersistedCanonicalEvent extends CanonicalEvent {
  seq: number;
}

export interface CanonicalIdentity {
  providerDriverKind: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  runtimeGeneration: number;
}

export function parseCanonicalEvent(value: unknown): CanonicalEvent {
  return normalizeCanonicalEvent(canonicalEventSchema.parse(value));
}

export function parseCanonicalEventPayload(value: unknown): CanonicalEventPayload {
  return canonicalEventPayloadSchema.parse(value);
}

export function canonicalPayloadJson(payload: CanonicalEventPayload): string {
  return stableJson(payload);
}

export function envelopesAreByteEquivalent(left: CanonicalEvent, right: CanonicalEvent): boolean {
  return (
    left.eventId === right.eventId &&
    left.providerDriverKind === right.providerDriverKind &&
    left.providerInstanceId === right.providerInstanceId &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.createdAt === right.createdAt &&
    left.turnId === right.turnId &&
    stableJson(left.target) === stableJson(right.target) &&
    stableJson(left.nativeCorrelation ?? null) === stableJson(right.nativeCorrelation ?? null) &&
    canonicalPayloadJson(left.payload) === canonicalPayloadJson(right.payload)
  );
}

export function projectTranscriptEvent(
  event: PersistedCanonicalEvent,
): TranscriptEvent | undefined {
  switch (event.payload.type) {
    case 'transcript': {
      const { transcript } = event.payload;
      const projected: TranscriptEvent = {
        id: event.eventId,
        ...targetToBridgeIdentity(event.target),
        role: transcript.role,
        ts: event.createdAt,
        seq: event.seq,
        kind: transcript.kind,
      };
      if (transcript.endAt !== undefined) projected.endTs = transcript.endAt;
      assignIfPresent(projected, 'text', transcript.text);
      assignIfPresent(projected, 'toolName', transcript.toolName);
      if (transcript.toolArgs !== undefined) projected.toolArgs = transcript.toolArgs;
      assignIfPresent(projected, 'toolUseId', transcript.toolUseId);
      assignIfPresent(projected, 'isError', transcript.isError);
      assignIfPresent(projected, 'removedCount', transcript.removedCount);
      assignIfPresent(projected, 'author', transcript.author);
      assignIfPresent(projected, 'skills', transcript.skills);
      assignIfPresent(projected, 'files', transcript.files);
      assignIfPresent(projected, 'browserRefs', transcript.browserRefs);
      assignIfPresent(projected, 'steered', transcript.steered);
      assignIfPresent(projected, 'compactType', transcript.compactType);
      return projected;
    }
    case 'session.lifecycle':
    case 'turn.started':
    case 'usage':
    case 'approval.lifecycle':
    case 'question.lifecycle':
    case 'plan_review.lifecycle':
    case 'session.effect':
    case 'binding.updated':
    case 'turn.settled':
    case 'warning':
    case 'error':
      return undefined;
    default: {
      const exhaustive: never = event.payload;
      return exhaustive;
    }
  }
}

export function liftRendererTranscriptEvent(
  event: TranscriptEvent,
  identity: CanonicalIdentity,
): CanonicalEvent {
  const transcript: CanonicalTranscriptPayload = {
    role: event.role,
    kind: event.kind,
  };
  if (event.endTs !== undefined) transcript.endAt = event.endTs;
  assignIfPresent(transcript, 'text', event.text);
  assignIfPresent(transcript, 'toolName', event.toolName);
  if (event.toolArgs !== undefined) transcript.toolArgs = event.toolArgs;
  assignIfPresent(transcript, 'toolUseId', event.toolUseId);
  assignIfPresent(transcript, 'isError', event.isError);
  assignIfPresent(transcript, 'removedCount', event.removedCount);
  assignIfPresent(transcript, 'author', event.author);
  assignIfPresent(transcript, 'skills', event.skills);
  assignIfPresent(transcript, 'files', event.files);
  assignIfPresent(transcript, 'browserRefs', event.browserRefs);
  assignIfPresent(transcript, 'steered', event.steered);
  assignIfPresent(transcript, 'compactType', event.compactType);
  return {
    eventId: event.id,
    target: bridgeIdentityToTarget(event),
    providerDriverKind: identity.providerDriverKind,
    providerInstanceId: identity.providerInstanceId,
    runtimeGeneration: identity.runtimeGeneration,
    createdAt: event.ts,
    payload: { type: 'transcript', transcript },
  };
}

export function searchTextForPayload(payload: CanonicalEventPayload): string {
  switch (payload.type) {
    case 'transcript': {
      const { transcript } = payload;
      if (transcript.kind !== 'text' || transcript.text === undefined || transcript.text === '') {
        return '';
      }
      return transcript.text.replace(/\s+/g, ' ');
    }
    case 'session.lifecycle':
    case 'turn.started':
    case 'usage':
    case 'approval.lifecycle':
    case 'question.lifecycle':
    case 'plan_review.lifecycle':
    case 'session.effect':
    case 'binding.updated':
    case 'turn.settled':
    case 'warning':
    case 'error':
      return '';
    default: {
      const exhaustive: never = payload;
      return exhaustive;
    }
  }
}

export function searchAuthorForPayload(
  payload: CanonicalEventPayload,
): 'user' | 'assistant' | undefined {
  if (payload.type !== 'transcript') return undefined;
  if (payload.transcript.kind !== 'text' || !payload.transcript.text) return undefined;
  return payload.transcript.author === 'user' ? 'user' : 'assistant';
}

export function parentAppSessionId(target: SessionTarget): string {
  return target.kind === 'session' ? target.appSessionId : target.parentAppSessionId;
}

export function childSessionId(target: SessionTarget): string | undefined {
  return target.kind === 'child' ? target.childSessionId : undefined;
}

function targetToBridgeIdentity(target: SessionTarget): {
  appSessionId: string;
  sourceSessionId: string;
} {
  if (target.kind === 'session') {
    return { appSessionId: target.appSessionId, sourceSessionId: target.appSessionId };
  }
  return {
    appSessionId: target.parentAppSessionId,
    sourceSessionId: target.childSessionId,
  };
}

function bridgeIdentityToTarget(event: TranscriptEvent): SessionTarget {
  if (event.sourceSessionId === event.appSessionId) {
    return { kind: 'session', appSessionId: event.appSessionId };
  }
  return {
    kind: 'child',
    parentAppSessionId: event.appSessionId,
    childSessionId: event.sourceSessionId,
  };
}

function normalizeCanonicalEvent(event: CanonicalEvent): CanonicalEvent {
  const correlation = normalizeNativeCorrelation(event.nativeCorrelation);
  const normalized: CanonicalEvent = {
    eventId: event.eventId,
    target: event.target,
    providerDriverKind: event.providerDriverKind,
    providerInstanceId: event.providerInstanceId,
    runtimeGeneration: event.runtimeGeneration,
    createdAt: event.createdAt,
    payload: event.payload,
  };
  if (event.turnId !== undefined) normalized.turnId = event.turnId;
  if (correlation !== undefined) normalized.nativeCorrelation = correlation;
  return normalized;
}

function normalizeNativeCorrelation(
  correlation: CanonicalNativeCorrelation | undefined,
): CanonicalNativeCorrelation | undefined {
  if (correlation === undefined) return undefined;
  const normalized: CanonicalNativeCorrelation = {};
  if (correlation.sessionId !== undefined) normalized.sessionId = correlation.sessionId;
  if (correlation.turnId !== undefined) normalized.turnId = correlation.turnId;
  if (correlation.itemId !== undefined) normalized.itemId = correlation.itemId;
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function assignIfPresent<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const next = record[key];
      if (next === undefined) continue;
      sorted[key] = stabilize(next);
    }
    return sorted;
  }
  return value;
}

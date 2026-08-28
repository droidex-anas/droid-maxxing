// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/AcpRuntimeModel.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

const toolCallContentEntrySchema = z
  .object({
    type: z.string(),
    content: contentBlockSchema.optional(),
  })
  .passthrough();

const sessionUpdateSchema = z
  .object({
    sessionUpdate: z.string(),
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    content: z.union([contentBlockSchema, z.array(toolCallContentEntrySchema)]).optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  })
  .passthrough();

const sessionUpdateMetaSchema = z
  .object({
    isReplay: z.boolean().optional(),
  })
  .passthrough();

const sessionUpdateParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    update: sessionUpdateSchema,
    _meta: sessionUpdateMetaSchema.optional(),
  })
  .passthrough();

export const CURSOR_TOOL_OUTPUT_MAX_CHARS = 8_000;
export const CURSOR_TOOL_UPDATE_MIN_DETAIL_GROWTH_CHARS = 256;
export const CURSOR_TOOL_UPDATE_COALESCE_LIMIT = 10;
const TOOL_CALL_CONTENT_TRUNCATION_MARKER = '[Earlier output truncated]\n\n';

export const CURSOR_ACP_KIND_TO_TOOL_NAME = [
  { acpKind: 'execute', toolName: 'command execution' },
  { acpKind: 'edit', toolName: 'file change' },
  { acpKind: 'delete', toolName: 'file change' },
  { acpKind: 'move', toolName: 'file change' },
  { acpKind: 'search', toolName: 'web search' },
  { acpKind: 'fetch', toolName: 'web search' },
] as const;

export interface CursorAssistantTextDelta {
  text: string;
}

export interface CursorToolCallState {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: 'pending' | 'inProgress' | 'completed' | 'failed';
  detail?: string;
}

export interface CursorToolCallCoalesceState {
  previous: CursorToolCallState | undefined;
  lastEmittedDetailLength: number | undefined;
  skippedSinceEmit: number;
}

export interface CursorToolCallEmitDecision {
  emit: boolean;
  skippedSinceEmit: number;
}

export function sessionUpdateIsReplay(params: unknown): boolean {
  const parsed = sessionUpdateParamsSchema.safeParse(params);
  return parsed.success && parsed.data._meta?.isReplay === true;
}

export function parseCursorAssistantTextDelta(
  params: unknown,
): CursorAssistantTextDelta | undefined {
  const parsed = sessionUpdateParamsSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  const update = parsed.data.update;
  if (update.sessionUpdate !== 'agent_message_chunk') {
    return undefined;
  }
  const content = update.content;
  if (!content || Array.isArray(content) || content.type !== 'text') {
    return undefined;
  }
  const text = content.text ?? '';
  if (text.length === 0) {
    return undefined;
  }
  return { text };
}

export function toolNameForAcpKind(kind: string | undefined): string {
  if (!kind) {
    return 'dynamic tool call';
  }
  const row = CURSOR_ACP_KIND_TO_TOOL_NAME.find((entry) => entry.acpKind === kind);
  return row?.toolName ?? 'dynamic tool call';
}

export function boundToolCallOutputText(text: string): string {
  // Keep the last 8,000 characters: command output's useful signal is at the tail.
  if (text.length <= CURSOR_TOOL_OUTPUT_MAX_CHARS) {
    return text;
  }
  const tail = text.slice(text.length - CURSOR_TOOL_OUTPUT_MAX_CHARS);
  return `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${tail}`;
}

export function parseCursorToolCallUpdate(params: unknown): CursorToolCallState | undefined {
  const parsed = sessionUpdateParamsSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  const update = parsed.data.update;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return undefined;
  }
  const toolCallId = update.toolCallId?.trim();
  if (!toolCallId) {
    return undefined;
  }
  const kind = update.kind?.trim() || undefined;
  const title = update.title?.trim() || undefined;
  const status = normalizeToolCallStatus(update.status);
  const detail = boundToolCallOutputText(extractToolCallDetail(update));
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function mergeToolCallState(
  previous: CursorToolCallState | undefined,
  next: CursorToolCallState,
): CursorToolCallState {
  return {
    toolCallId: next.toolCallId,
    kind: next.kind ?? previous?.kind,
    title: next.title ?? previous?.title,
    status: next.status ?? previous?.status,
    detail: next.detail ?? previous?.detail,
  };
}

export function decideToolCallUpdateEmission(input: {
  previous: CursorToolCallState | undefined;
  next: CursorToolCallState;
  lastEmittedDetailLength: number | undefined;
  skippedSinceEmit: number;
}): CursorToolCallEmitDecision {
  const { previous, next, lastEmittedDetailLength, skippedSinceEmit } = input;
  if (next.status === 'completed' || next.status === 'failed') {
    return { emit: true, skippedSinceEmit: 0 };
  }
  if (previous === undefined || previous.title !== next.title || previous.status !== next.status) {
    return { emit: true, skippedSinceEmit: 0 };
  }
  if (previous.detail === next.detail) {
    return { emit: false, skippedSinceEmit };
  }
  const progressLength = next.detail?.length ?? 0;
  const grewMeaningfully =
    lastEmittedDetailLength === undefined ||
    Math.abs(progressLength - lastEmittedDetailLength) >=
      CURSOR_TOOL_UPDATE_MIN_DETAIL_GROWTH_CHARS;
  // Emit on 256-char growth, every 10th suppressed update, or any terminal status.
  if (grewMeaningfully || skippedSinceEmit + 1 >= CURSOR_TOOL_UPDATE_COALESCE_LIMIT) {
    return { emit: true, skippedSinceEmit: 0 };
  }
  return { emit: false, skippedSinceEmit: skippedSinceEmit + 1 };
}

export function ingestCursorToolCallUpdate(
  states: Map<string, CursorToolCallCoalesceState>,
  params: unknown,
): { emit: true; toolCall: CursorToolCallState } | { emit: false } | undefined {
  const parsed = parseCursorToolCallUpdate(params);
  if (!parsed) {
    return undefined;
  }
  const current = states.get(parsed.toolCallId) ?? {
    previous: undefined,
    lastEmittedDetailLength: undefined,
    skippedSinceEmit: 0,
  };
  const merged = mergeToolCallState(current.previous, parsed);
  const decision = decideToolCallUpdateEmission({
    previous: current.previous,
    next: merged,
    lastEmittedDetailLength: current.lastEmittedDetailLength,
    skippedSinceEmit: current.skippedSinceEmit,
  });
  const nextState: CursorToolCallCoalesceState = {
    previous: merged,
    lastEmittedDetailLength: decision.emit
      ? (merged.detail?.length ?? current.lastEmittedDetailLength)
      : current.lastEmittedDetailLength,
    skippedSinceEmit: decision.skippedSinceEmit,
  };
  if (merged.status === 'completed' || merged.status === 'failed') {
    states.delete(parsed.toolCallId);
  } else {
    states.set(parsed.toolCallId, nextState);
  }
  return decision.emit ? { emit: true, toolCall: merged } : { emit: false };
}

function normalizeToolCallStatus(
  status: string | undefined,
): CursorToolCallState['status'] | undefined {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
    case 'inProgress':
      return 'inProgress';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

function extractToolCallDetail(update: {
  content?: unknown;
  rawOutput?: unknown;
  title?: string;
}): string {
  const fromContent = toolCallContentText(update.content);
  if (fromContent) {
    return fromContent;
  }
  if (isPlainObject(update.rawOutput)) {
    for (const field of ['content', 'stdout', 'stderr', 'output'] as const) {
      const value = update.rawOutput[field];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }
  return update.title?.trim() ?? '';
}

function toolCallContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const entry of content) {
    if (!isPlainObject(entry) || !isPlainObject(entry.content)) {
      continue;
    }
    if (entry.content.type !== 'text') {
      continue;
    }
    const text = typeof entry.content.text === 'string' ? entry.content.text.trim() : '';
    if (text) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join('\n') : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

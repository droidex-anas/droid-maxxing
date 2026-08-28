// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/AcpRuntimeModel.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

export const TOOL_CALL_CONTENT_MAX_CHARS = 8_000;
export const TOOL_CALL_CONTENT_TRUNCATION_MARKER = '[Earlier output truncated]\n\n';
export const TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS = 256;
export const TOOL_CALL_UPDATE_COALESCE_LIMIT = 10;

const RAW_OUTPUT_TEXT_FIELDS = ['content', 'stdout', 'stderr', 'output'] as const;

export const ACP_KIND_TO_TOOL_NAME = [
  { acpKind: 'execute', toolName: 'command execution' },
  { acpKind: 'edit', toolName: 'file change' },
  { acpKind: 'delete', toolName: 'file change' },
  { acpKind: 'move', toolName: 'file change' },
  { acpKind: 'search', toolName: 'web search' },
  { acpKind: 'fetch', toolName: 'web search' },
] as const;

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
    content: z.union([contentBlockSchema, z.array(toolCallContentEntrySchema)]).optional(),
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    locations: z.unknown().optional(),
  })
  .passthrough();

const sessionUpdateMetaSchema = z
  .object({
    isReplay: z.boolean().optional(),
  })
  .passthrough();

export const sessionUpdateParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    update: sessionUpdateSchema,
    _meta: sessionUpdateMetaSchema.optional(),
  })
  .passthrough();

export type SessionUpdateParams = z.infer<typeof sessionUpdateParamsSchema>;

export interface AcpAssistantTextDelta {
  text: string;
}

export type AcpToolCallStatus = 'pending' | 'inProgress' | 'completed' | 'failed';

export interface AcpToolCallState {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: AcpToolCallStatus;
  command?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface AcpToolCallCoalesceState {
  previous: AcpToolCallState | undefined;
  lastEmittedDetailLength: number | undefined;
  skippedSinceEmit: number;
}

export interface AcpToolCallEmitDecisionInput {
  readonly previous: AcpToolCallState | undefined;
  readonly next: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

export interface AcpToolCallEmitDecision {
  readonly emit: boolean;
  readonly skippedSinceEmit: number;
}

export function sessionUpdateIsReplay(params: unknown): boolean {
  const parsed = sessionUpdateParamsSchema.safeParse(params);
  return parsed.success && parsed.data._meta?.isReplay === true;
}

export function parseAssistantTextDelta(params: unknown): AcpAssistantTextDelta | undefined {
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
  const row = ACP_KIND_TO_TOOL_NAME.find((entry) => entry.acpKind === kind);
  return row?.toolName ?? 'dynamic tool call';
}

export function parseToolCallUpdate(params: unknown): AcpToolCallState | undefined {
  const parsed = sessionUpdateParamsSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  const update = parsed.data.update;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return undefined;
  }
  const fallbackStatus = update.sessionUpdate === 'tool_call' ? 'pending' : undefined;
  return makeToolCallState(update, fallbackStatus);
}

export function boundToolCallOutputText(text: string): string {
  if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
    return text;
  }
  return `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${text.slice(text.length - TOOL_CALL_CONTENT_MAX_CHARS)}`;
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = next.kind ?? (typeof next.data?.kind === 'string' ? next.data.kind : undefined);
  const kind = nextKind ?? previous?.kind;
  const title = next.title ?? previous?.title;
  const status = next.status ?? previous?.status;
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: {
      ...previous?.data,
      ...next.data,
    },
  };
}

export function toolCallProgressLength(state: AcpToolCallState): number {
  const data = state.data ?? {};
  let contentChars = 0;
  const content = data.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      const text = toolCallContentEntryText(entry);
      if (text) {
        contentChars += text.length;
      }
    }
  }
  let rawOutputChars = 0;
  const rawOutput = data.rawOutput;
  if (isPlainObject(rawOutput)) {
    for (const field of RAW_OUTPUT_TEXT_FIELDS) {
      const value = rawOutput[field];
      if (typeof value === 'string') {
        rawOutputChars += value.length;
      }
    }
  }
  return Math.max(state.detail?.length ?? 0, contentChars, rawOutputChars);
}

export function decideToolCallUpdateEmission(
  input: AcpToolCallEmitDecisionInput,
): AcpToolCallEmitDecision {
  const { previous, next, lastEmittedDetailLength, skippedSinceEmit } = input;
  if (next.status === 'completed' || next.status === 'failed') {
    return { emit: true, skippedSinceEmit: 0 };
  }
  if (previous === undefined || previous.title !== next.title || previous.status !== next.status) {
    return { emit: true, skippedSinceEmit: 0 };
  }
  if (previous.detail === next.detail && toolCallOutputUnchanged(previous, next)) {
    return { emit: false, skippedSinceEmit };
  }
  const progressLength = toolCallProgressLength(next);
  const grewMeaningfully =
    lastEmittedDetailLength === undefined ||
    Math.abs(progressLength - lastEmittedDetailLength) >= TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS;
  if (grewMeaningfully || skippedSinceEmit + 1 >= TOOL_CALL_UPDATE_COALESCE_LIMIT) {
    return { emit: true, skippedSinceEmit: 0 };
  }
  return { emit: false, skippedSinceEmit: skippedSinceEmit + 1 };
}

export function ingestToolCallUpdate(
  states: Map<string, AcpToolCallCoalesceState>,
  params: unknown,
): { emit: true; toolCall: AcpToolCallState } | { emit: false } | undefined {
  const parsed = parseToolCallUpdate(params);
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
  const nextState: AcpToolCallCoalesceState = {
    previous: merged,
    lastEmittedDetailLength: decision.emit
      ? toolCallProgressLength(merged)
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

function makeToolCallState(
  update: z.infer<typeof sessionUpdateSchema>,
  fallbackStatus: AcpToolCallStatus | undefined,
): AcpToolCallState | undefined {
  const toolCallId = update.toolCallId?.trim();
  if (!toolCallId) {
    return undefined;
  }
  const title = update.title?.trim() || undefined;
  const command = extractToolCallCommand(update.rawInput, title);
  const extracted = extractBoundedContent(update.content);
  const kind = normalizeToolKind(update.kind);
  const status = normalizeToolCallStatus(update.status, fallbackStatus);
  const data: Record<string, unknown> = { toolCallId };
  if (kind) {
    data.kind = kind;
  }
  if (command) {
    data.command = command;
  }
  if (update.rawInput !== undefined) {
    data.rawInput = update.rawInput;
  }
  if (update.rawOutput !== undefined) {
    data.rawOutput = boundToolCallRawOutput(update.rawOutput);
  }
  if (update.content !== undefined) {
    data.content = extracted.content ?? update.content;
  }
  if (update.locations !== undefined) {
    data.locations = update.locations;
  }
  const detail = boundToolCallOutputText(extractToolCallDetail(update, extracted.text, title));
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data,
  };
}

function extractToolCallDetail(
  update: { rawOutput?: unknown },
  contentText: string | undefined,
  title: string | undefined,
): string {
  if (contentText) {
    return contentText;
  }
  if (isPlainObject(update.rawOutput)) {
    for (const field of RAW_OUTPUT_TEXT_FIELDS) {
      const value = update.rawOutput[field];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }
  return title?.trim() ?? '';
}

function extractBoundedContent(content: unknown): {
  text: string | undefined;
  content: unknown;
} {
  if (!Array.isArray(content)) {
    return { text: undefined, content };
  }
  const chunks: string[] = [];
  const bounded = content.map((entry) => {
    const text = toolCallContentEntryText(entry);
    if (text === undefined) {
      return entry;
    }
    if (text.trim()) {
      chunks.push(text.trim());
    }
    if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
      return entry;
    }
    if (!isPlainObject(entry)) {
      return entry;
    }
    return {
      ...entry,
      content: { type: 'text', text: boundToolCallOutputText(text) },
    };
  });
  if (chunks.length === 0) {
    return { text: undefined, content: bounded };
  }
  const joined = chunks.join('\n');
  return {
    text: boundToolCallOutputText(joined),
    content: bounded,
  };
}

function boundToolCallRawOutput(rawOutput: unknown): unknown {
  if (!isPlainObject(rawOutput)) {
    return rawOutput;
  }
  let changed = false;
  const bounded: Record<string, unknown> = { ...rawOutput };
  for (const field of RAW_OUTPUT_TEXT_FIELDS) {
    const value = rawOutput[field];
    if (typeof value === 'string' && value.length > TOOL_CALL_CONTENT_MAX_CHARS) {
      bounded[field] = boundToolCallOutputText(value);
      changed = true;
    }
  }
  return changed ? bounded : rawOutput;
}

function toolCallContentEntryText(entry: unknown): string | undefined {
  if (!isPlainObject(entry) || entry.type !== 'content') {
    return undefined;
  }
  const content = entry.content;
  if (!isPlainObject(content) || content.type !== 'text' || typeof content.text !== 'string') {
    return undefined;
  }
  return content.text;
}

function toolCallOutputUnchanged(previous: AcpToolCallState, next: AcpToolCallState): boolean {
  return (
    previous.data?.content === next.data?.content &&
    previous.data?.rawOutput === next.data?.rawOutput
  );
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: AcpToolCallStatus,
): AcpToolCallStatus | undefined {
  switch (raw) {
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
      return fallback;
  }
}

function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === 'string' && kind.trim().length > 0 ? kind.trim() : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      parts.push(entry.trim());
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isPlainObject(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === 'string' ? rawInput.executable.trim() : '';
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

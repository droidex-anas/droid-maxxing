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

const sessionUpdateSchema = z
  .object({
    sessionUpdate: z.string(),
    content: contentBlockSchema.optional(),
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

export interface CursorAssistantTextDelta {
  text: string;
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
  if (!content || content.type !== 'text') {
    return undefined;
  }
  const text = content.text ?? '';
  if (text.length === 0) {
    return undefined;
  }
  return { text };
}

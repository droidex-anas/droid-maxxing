// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import type { AcpToolCallState } from '../acp/acpSessionUpdate.js';

export function isGrokEnterPlanModeToolCall(toolCall: {
  readonly title?: string;
  readonly data?: Record<string, unknown>;
}): boolean {
  const title = toolCall.title?.trim().toLowerCase() ?? '';
  if (
    title === 'enter_plan_mode' ||
    title === 'plan: enter' ||
    title === 'plan mode entered' ||
    title.includes('enter_plan_mode')
  ) {
    return true;
  }
  const rawInput = toolCall.data?.rawInput;
  return isPlainObject(rawInput) && rawInput.variant === 'EnterPlanMode';
}

export function nextGrokPlanModeActive(
  currentlyActive: boolean,
  toolCall: AcpToolCallState,
): boolean {
  if (!isGrokEnterPlanModeToolCall(toolCall)) {
    return currentlyActive;
  }
  if (toolCall.status === 'failed') {
    return false;
  }
  if (toolCall.status === 'completed' || toolCall.status === 'inProgress') {
    return true;
  }
  return currentlyActive;
}

export function shouldEmitPlanBody(input: {
  lastBody: string | undefined;
  lastTurnId: string | undefined;
  turnId: string;
  body: string;
}): boolean {
  const trimmed = input.body.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !(input.lastBody === trimmed && input.lastTurnId === input.turnId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

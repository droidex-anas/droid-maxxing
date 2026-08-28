// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/XAiAcpExtension.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

export const XAI_RATE_LIMITED_RPC_CODE = -32003;

export const XAI_ASK_USER_QUESTION_METHODS = [
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
] as const;

export const XAI_EXIT_PLAN_MODE_METHODS = ['x.ai/exit_plan_mode', '_x.ai/exit_plan_mode'] as const;

export const XAI_PROMPT_COMPLETE_METHODS = [
  'x.ai/session/prompt_complete',
  '_x.ai/session/prompt_complete',
] as const;

export const XAI_EMPTY_PLAN_MARKDOWN =
  '# No plan written yet\n\n(The agent exited plan mode without writing a plan.)';

const askOptionSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    preview: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

const askQuestionSchema = z
  .object({
    id: z.string().optional(),
    question: z.string().min(1),
    options: z.array(askOptionSchema),
    multiSelect: z.union([z.boolean(), z.null()]).optional(),
  })
  .passthrough();

const askParamsSchema = z
  .object({
    sessionId: z.string(),
    toolCallId: z.string(),
    questions: z.array(askQuestionSchema),
    mode: z.enum(['default', 'plan']),
  })
  .passthrough();

const wrappedAskSchema = z
  .object({
    method: z.enum(XAI_ASK_USER_QUESTION_METHODS),
    params: askParamsSchema,
  })
  .passthrough();

export const xaiAskUserQuestionRequestSchema = z.union([askParamsSchema, wrappedAskSchema]);

export type XaiAskUserQuestionParams = z.infer<typeof askParamsSchema>;

const exitParamsSchema = z
  .object({
    sessionId: z.string(),
    toolCallId: z.string(),
    planContent: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const wrappedExitSchema = z
  .object({
    method: z.enum(XAI_EXIT_PLAN_MODE_METHODS),
    params: exitParamsSchema,
  })
  .passthrough();

export const xaiExitPlanModeRequestSchema = z.union([exitParamsSchema, wrappedExitSchema]);

export type XaiExitPlanModeParams = z.infer<typeof exitParamsSchema>;

export const xaiPromptCompleteSchema = z
  .object({
    sessionId: z.string(),
    promptId: z.string().optional(),
    stopReason: z.string().optional(),
    agentResult: z.unknown().optional(),
  })
  .passthrough();

export type XaiPromptCompleteNotification = z.infer<typeof xaiPromptCompleteSchema>;

export function unwrapAskUserQuestionParams(value: unknown): XaiAskUserQuestionParams | undefined {
  const wrapped = wrappedAskSchema.safeParse(value);
  if (wrapped.success) {
    return wrapped.data.params;
  }
  const direct = askParamsSchema.safeParse(value);
  return direct.success ? direct.data : undefined;
}

export function unwrapExitPlanModeParams(value: unknown): XaiExitPlanModeParams | undefined {
  const wrapped = wrappedExitSchema.safeParse(value);
  if (wrapped.success) {
    return wrapped.data.params;
  }
  const direct = exitParamsSchema.safeParse(value);
  return direct.success ? direct.data : undefined;
}

export function parseXaiPromptComplete(value: unknown): XaiPromptCompleteNotification | undefined {
  const parsed = xaiPromptCompleteSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function extractXaiExitPlanMarkdown(
  params: XaiExitPlanModeParams,
  fallback?: string,
): string {
  const fromRequest = typeof params.planContent === 'string' ? params.planContent.trim() : '';
  if (fromRequest.length > 0) {
    return fromRequest;
  }
  const fromFallback = fallback?.trim();
  if (fromFallback && fromFallback.length > 0) {
    return fromFallback;
  }
  return XAI_EMPTY_PLAN_MARKDOWN;
}

export function grokQuestionsForSink(params: XaiAskUserQuestionParams): {
  id: string;
  prompt: string;
  options: readonly string[];
  multiSelect: boolean;
}[] {
  return params.questions.map((question) => ({
    id: question.id ?? question.question,
    prompt: question.question,
    options: question.options.map((option) => option.label),
    multiSelect: question.multiSelect === true,
  }));
}

// xAI answers must be keyed by question text, not by the optional question id.
export function grokAnswersKeyedByQuestionText(
  params: XaiAskUserQuestionParams,
  answers: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const keyed: Record<string, readonly string[]> = {};
  for (const question of params.questions) {
    const raw = answers[question.id ?? question.question] ?? answers[question.question];
    if (raw === undefined) {
      continue;
    }
    const optionByLabel = new Map(question.options.map((option) => [option.label, option]));
    const selected = raw.flatMap((value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }
      return optionByLabel.has(trimmed) ? [trimmed] : [];
    });
    keyed[question.question] = selected.length > 0 ? selected : ['Other'];
  }
  return keyed;
}

export function makeXaiAskUserQuestionResponse(
  params: XaiAskUserQuestionParams,
  answers: Readonly<Record<string, readonly string[]>>,
): { outcome: 'accepted'; answers: Record<string, readonly string[]> } {
  return {
    outcome: 'accepted',
    answers: grokAnswersKeyedByQuestionText(params, answers),
  };
}

export function makeXaiAskUserQuestionCancelledResponse(): { outcome: 'cancelled' } {
  return { outcome: 'cancelled' };
}

// Answer immediately so Grok's native plan-approval gate cannot hang the turn.
export function makeXaiExitPlanModeCapturedResponse(): {
  outcome: 'abandoned';
  feedback: string;
} {
  return {
    outcome: 'abandoned',
    feedback:
      "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
  };
}

export function isXaiAskUserQuestionMethod(method: string): boolean {
  return (XAI_ASK_USER_QUESTION_METHODS as readonly string[]).includes(method);
}

export function isXaiExitPlanModeMethod(method: string): boolean {
  return (XAI_EXIT_PLAN_MODE_METHODS as readonly string[]).includes(method);
}

export function isXaiPromptCompleteMethod(method: string): boolean {
  return (XAI_PROMPT_COMPLETE_METHODS as readonly string[]).includes(method);
}

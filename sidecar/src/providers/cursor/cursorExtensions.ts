// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/CursorAcpExtension.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import type { ProviderPlanReviewDecision, ProviderQuestionAnswer } from '../providerTypes.js';

const cursorAskQuestionOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
  })
  .passthrough();

const cursorAskQuestionSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    options: z.array(cursorAskQuestionOptionSchema),
    allowMultiple: z.boolean().optional(),
  })
  .passthrough();

export const cursorAskQuestionRequestSchema = z
  .object({
    toolCallId: z.string().min(1),
    title: z.string().optional(),
    questions: z.array(cursorAskQuestionSchema).min(1),
  })
  .passthrough();

const cursorTodoSchema = z
  .object({
    id: z.string().optional(),
    content: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const cursorPlanPhaseSchema = z
  .object({
    name: z.string(),
    todos: z.array(cursorTodoSchema),
  })
  .passthrough();

export const cursorCreatePlanRequestSchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().optional(),
    overview: z.string().optional(),
    plan: z.string(),
    todos: z.array(cursorTodoSchema),
    isProject: z.boolean().optional(),
    phases: z.array(cursorPlanPhaseSchema).optional(),
  })
  .passthrough();

export const cursorUpdateTodosRequestSchema = z
  .object({
    toolCallId: z.string().min(1),
    todos: z.array(cursorTodoSchema),
    merge: z.boolean(),
  })
  .passthrough();

export interface CursorParsedQuestion {
  id: string;
  prompt: string;
  options: readonly { id: string; label: string }[];
  allowMultiple: boolean;
}

export interface CursorParsedAskQuestion {
  toolCallId: string;
  title?: string;
  questions: readonly CursorParsedQuestion[];
}

export interface CursorPlanTodo {
  id?: string;
  content?: string;
  title?: string;
  status?: string;
}

export interface CursorParsedCreatePlan {
  toolCallId: string;
  plan: string;
  todos: readonly CursorPlanTodo[];
}

export interface CursorParsedUpdateTodos {
  toolCallId: string;
  todos: readonly CursorPlanTodo[];
  merge: boolean;
}

export interface CursorPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export function parseCursorAskQuestion(params: unknown): CursorParsedAskQuestion | undefined {
  const parsed = cursorAskQuestionRequestSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  return {
    toolCallId: parsed.data.toolCallId,
    ...(parsed.data.title?.trim() ? { title: parsed.data.title.trim() } : {}),
    questions: parsed.data.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      allowMultiple: question.allowMultiple === true,
      options: question.options.map((option) => ({ id: option.id, label: option.label })),
    })),
  };
}

export function parseCursorCreatePlan(params: unknown): CursorParsedCreatePlan | undefined {
  const parsed = cursorCreatePlanRequestSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  return {
    toolCallId: parsed.data.toolCallId,
    plan: parsed.data.plan || '# Plan\n\n(Cursor did not supply plan text.)',
    todos: parsed.data.todos,
  };
}

export function parseCursorUpdateTodos(params: unknown): CursorParsedUpdateTodos | undefined {
  const parsed = cursorUpdateTodosRequestSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  return {
    toolCallId: parsed.data.toolCallId,
    todos: parsed.data.todos,
    merge: parsed.data.merge,
  };
}

export function questionRequestFromAskQuestion(parsed: CursorParsedAskQuestion): {
  id: string;
  prompt: string;
  options: readonly string[];
  multiSelect: boolean;
}[] {
  return parsed.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    multiSelect: question.allowMultiple,
    options: question.options.length > 0 ? question.options.map((option) => option.label) : ['OK'],
  }));
}

export function reconstructCursorAskQuestionAnswers(
  questions: readonly CursorParsedQuestion[],
  answer: ProviderQuestionAnswer,
): { answers: Record<string, string | readonly string[]> } {
  if (answer.status === 'cancelled') {
    return { answers: {} };
  }
  const answers: Record<string, string | readonly string[]> = {};
  for (const question of questions) {
    const selected = answer.answers[question.id];
    if (selected === undefined) {
      continue;
    }
    const mapped = selected.map((value) => {
      const byId = question.options.find((option) => option.id === value);
      const byLabel = question.options.find((option) => option.label === value);
      return byId?.id ?? byLabel?.id ?? value;
    });
    answers[question.id] = question.allowMultiple ? mapped : (mapped[0] ?? '');
  }
  return { answers };
}

export function cursorCreatePlanAcpResult(decision: ProviderPlanReviewDecision): unknown {
  switch (decision.decision) {
    case 'implement':
      return { accepted: true };
    case 'iterate':
      return { accepted: false, feedback: decision.feedback };
    case 'cancel':
      return { accepted: false };
  }
}

export function extractTodosAsPlan(todos: readonly CursorPlanTodo[]): {
  plan: readonly CursorPlanStep[];
} {
  const plan = todos.flatMap((todo) => {
    const step = todo.content?.trim() || todo.title?.trim() || '';
    if (step === '') {
      return [];
    }
    const status: CursorPlanStep['status'] =
      todo.status === 'completed'
        ? 'completed'
        : todo.status === 'in_progress' || todo.status === 'inProgress'
          ? 'inProgress'
          : 'pending';
    return [{ step, status }];
  });
  return { plan };
}

export function cursorTodoFingerprint(todos: readonly CursorPlanTodo[]): string {
  return JSON.stringify(
    todos.map((todo) => ({
      id: todo.id ?? '',
      content: todo.content ?? todo.title ?? '',
      status: todo.status ?? 'pending',
    })),
  );
}

export function formatCursorPlanSteps(steps: readonly CursorPlanStep[]): string {
  return steps
    .map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${step.step}`)
    .join('\n');
}

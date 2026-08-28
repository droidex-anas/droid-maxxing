import type { PermissionRequest, PlanReviewRequest, SessionQuestion } from '../protocol.js';
import { PERMISSION_OUTCOMES } from '../protocol.js';
import type { SessionTarget } from './providerIdentity.js';
import type {
  ProviderApprovalDecision,
  ProviderApprovalRequest,
  ProviderPlanReviewDecision,
  ProviderQuestionAnswer,
  ProviderQuestionRequest,
} from './providerTypes.js';

export const CANCEL_APPROVAL: ProviderApprovalDecision = { decision: 'cancel' };
export const CANCEL_QUESTION: ProviderQuestionAnswer = { status: 'cancelled' };
export const CANCEL_PLAN_REVIEW: ProviderPlanReviewDecision = { decision: 'cancel' };

const CLOSED_APPROVAL_DECISIONS = ['allow_once', 'allow_session', 'deny', 'cancel'] as const;

export function appSessionIdFromTarget(target: SessionTarget): string {
  return target.kind === 'session' ? target.appSessionId : target.parentAppSessionId;
}

export function canonicalRequestId(appSessionId: string, nativeRequestId: string): string {
  return `${appSessionId}:${nativeRequestId}`;
}

export function uniqueCanonicalRequestId(
  appSessionId: string,
  nativeRequestId: string,
  taken: (requestId: string) => boolean,
): string {
  const base = canonicalRequestId(appSessionId, nativeRequestId);
  if (!taken(base)) return base;
  let suffix = 1;
  while (taken(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

export function approvalDecisionFromOutcome(outcome: string): ProviderApprovalDecision {
  if (outcome === 'proceed_once') return { decision: 'allow_once' };
  if (outcome === 'proceed_always') return { decision: 'allow_session' };
  if (outcome === 'cancel') return { decision: 'cancel' };
  if ((PERMISSION_OUTCOMES as readonly string[]).includes(outcome)) {
    return { decision: 'option', option: outcome };
  }
  throw new Error(`Unsupported permission outcome: ${outcome}`);
}

export function parseApprovalDecision(value: unknown): ProviderApprovalDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid approval decision');
  }
  const record = value as Record<string, unknown>;
  if (record.decision === 'option') {
    if (typeof record.option !== 'string' || record.option.length === 0) {
      throw new Error('Invalid approval option');
    }
    return { decision: 'option', option: record.option };
  }
  if (
    typeof record.decision === 'string' &&
    (CLOSED_APPROVAL_DECISIONS as readonly string[]).includes(record.decision)
  ) {
    return { decision: record.decision as (typeof CLOSED_APPROVAL_DECISIONS)[number] };
  }
  throw new Error('Invalid approval decision');
}

export interface QuestionShape {
  id: string;
  multiSelect: boolean;
}

export function parseQuestionAnswer(
  cancelled: boolean,
  answers: unknown,
  questions: readonly QuestionShape[],
): ProviderQuestionAnswer {
  if (cancelled) return { status: 'cancelled' };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('Invalid question answers');
  }
  const record = answers as Record<string, unknown>;
  const expected = new Set(questions.map((question) => question.id));
  const keys = Object.keys(record);
  if (keys.length !== expected.size) {
    throw new Error('Invalid question answers');
  }
  for (const key of keys) {
    if (!expected.has(key)) throw new Error('Invalid question answers');
  }
  const normalized: Record<string, string[]> = {};
  for (const question of questions) {
    const value = record[question.id];
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('Invalid question answers');
    }
    const selected: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error('Invalid question answers');
      }
      selected.push(item);
    }
    if (!question.multiSelect && selected.length !== 1) {
      throw new Error('Invalid question answers');
    }
    normalized[question.id] = selected;
  }
  return { status: 'answered', answers: normalized };
}

export function parsePlanReviewDecision(value: unknown): ProviderPlanReviewDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid plan review decision');
  }
  const record = value as Record<string, unknown>;
  if (record.decision === 'implement') return { decision: 'implement' };
  if (record.decision === 'cancel') return { decision: 'cancel' };
  if (record.decision === 'iterate') {
    if (typeof record.feedback !== 'string' || record.feedback.trim().length === 0) {
      throw new Error('Invalid plan review decision');
    }
    return { decision: 'iterate', feedback: record.feedback.trim() };
  }
  throw new Error('Invalid plan review decision');
}

export function toPermissionRequest(
  appSessionId: string,
  requestId: string,
  input: ProviderApprovalRequest,
): PermissionRequest {
  return {
    appSessionId,
    requestId,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.options !== undefined ? { options: [...input.options] } : {}),
  };
}

export function toSessionQuestion(
  appSessionId: string,
  requestId: string,
  input: ProviderQuestionRequest,
): SessionQuestion {
  return {
    appSessionId,
    requestId,
    questions: input.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: [...question.options],
      multiSelect: question.multiSelect,
    })),
  };
}

export function toPlanReviewRequest(
  appSessionId: string,
  requestId: string,
  plan: string,
): PlanReviewRequest {
  return { appSessionId, requestId, plan };
}

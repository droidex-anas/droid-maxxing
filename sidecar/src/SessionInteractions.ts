import type { ServerEvent } from './protocol.js';
import { errMsg } from './sessionHelpers.js';
import {
  appSessionIdFromTarget,
  approvalDecisionFromOutcome,
  CANCEL_APPROVAL,
  CANCEL_PLAN_REVIEW,
  CANCEL_QUESTION,
  parsePlanReviewDecision,
  parseQuestionAnswer,
  toPermissionRequest,
  toPlanReviewRequest,
  toSessionQuestion,
  uniqueCanonicalRequestId,
} from './providers/providerInteractions.js';
import type {
  ProviderApprovalDecision,
  ProviderApprovalRequest,
  ProviderInteractionSink,
  ProviderPlanReviewDecision,
  ProviderPlanReviewRequest,
  ProviderQuestionAnswer,
  ProviderQuestionRequest,
} from './providers/providerTypes.js';

interface PendingApproval {
  resolve: (decision: ProviderApprovalDecision) => void;
  request: ProviderApprovalRequest;
}

interface PendingQuestion {
  resolve: (answer: ProviderQuestionAnswer) => void;
  request: ProviderQuestionRequest;
}

interface PendingPlanReview {
  resolve: (decision: ProviderPlanReviewDecision) => void;
  request: ProviderPlanReviewRequest;
}

interface InteractionScope {
  approvals: Map<string, PendingApproval>;
  questions: Map<string, PendingQuestion>;
  planReviews: Map<string, PendingPlanReview>;
}

type InteractionError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionInteractionsDependencies {
  emit: (event: ServerEvent) => void;
  emitError: (error: InteractionError) => void;
}

export class SessionInteractions implements ProviderInteractionSink {
  private readonly scopes = new Map<string, InteractionScope>();

  constructor(private readonly dependencies: SessionInteractionsDependencies) {}

  requestApproval(input: ProviderApprovalRequest): Promise<ProviderApprovalDecision> {
    return new Promise((resolve) => {
      const appSessionId = appSessionIdFromTarget(input.target);
      const scope = this.scope(appSessionId);
      const requestId = uniqueCanonicalRequestId(appSessionId, input.requestId, (id) =>
        this.hasPending(scope, id),
      );
      const request: ProviderApprovalRequest = { ...input, requestId };
      scope.approvals.set(requestId, { resolve, request });
      this.dependencies.emit({
        type: 'approval.requested',
        request: toPermissionRequest(appSessionId, requestId, request),
      });
    });
  }

  requestQuestion(input: ProviderQuestionRequest): Promise<ProviderQuestionAnswer> {
    return new Promise((resolve) => {
      const appSessionId = appSessionIdFromTarget(input.target);
      const scope = this.scope(appSessionId);
      const requestId = uniqueCanonicalRequestId(appSessionId, input.requestId, (id) =>
        this.hasPending(scope, id),
      );
      const request: ProviderQuestionRequest = { ...input, requestId };
      scope.questions.set(requestId, { resolve, request });
      this.dependencies.emit({
        type: 'question.requested',
        question: toSessionQuestion(appSessionId, requestId, request),
      });
    });
  }

  requestPlanReview(input: ProviderPlanReviewRequest): Promise<ProviderPlanReviewDecision> {
    return new Promise((resolve) => {
      const appSessionId = appSessionIdFromTarget(input.target);
      const scope = this.scope(appSessionId);
      const requestId = uniqueCanonicalRequestId(appSessionId, input.requestId, (id) =>
        this.hasPending(scope, id),
      );
      const request: ProviderPlanReviewRequest = { ...input, requestId };
      scope.planReviews.set(requestId, { resolve, request });
      this.dependencies.emit({
        type: 'plan_review.requested',
        request: toPlanReviewRequest(appSessionId, requestId, request.plan),
      });
    });
  }

  respondToApproval(appSessionId: string, requestId: string, outcome: string): void {
    const scope = this.scopes.get(appSessionId);
    const pending = scope?.approvals.get(requestId);
    if (!scope || !pending) return;
    let decision: ProviderApprovalDecision;
    try {
      decision = approvalDecisionFromOutcome(outcome);
    } catch (error) {
      this.dependencies.emitError({
        code: 'permission.invalid_outcome',
        appSessionId,
        message: errMsg(error),
      });
      return;
    }
    scope.approvals.delete(requestId);
    pending.resolve(decision);
  }

  respondToQuestion(
    appSessionId: string,
    requestId: string,
    cancelled: boolean,
    answers: Record<string, readonly string[]>,
  ): void {
    const scope = this.scopes.get(appSessionId);
    const pending = scope?.questions.get(requestId);
    if (!scope || !pending) return;
    let answer: ProviderQuestionAnswer;
    try {
      answer = parseQuestionAnswer(
        cancelled,
        answers,
        pending.request.questions.map((question) => ({
          id: question.id,
          multiSelect: question.multiSelect,
        })),
      );
    } catch (error) {
      this.dependencies.emitError({
        code: 'question.invalid_answer',
        appSessionId,
        message: errMsg(error),
      });
      return;
    }
    scope.questions.delete(requestId);
    pending.resolve(answer);
  }

  respondToPlanReview(appSessionId: string, requestId: string, value: unknown): void {
    const scope = this.scopes.get(appSessionId);
    const pending = scope?.planReviews.get(requestId);
    if (!scope || !pending) return;
    let decision: ProviderPlanReviewDecision;
    try {
      decision = parsePlanReviewDecision(value);
    } catch (error) {
      this.dependencies.emitError({
        code: 'plan_review.invalid_decision',
        appSessionId,
        message: errMsg(error),
      });
      return;
    }
    scope.planReviews.delete(requestId);
    pending.resolve(decision);
  }

  forgetSession(appSessionId: string): void {
    this.scopes.delete(appSessionId);
  }

  cancelSession(appSessionId: string): void {
    const scope = this.scopes.get(appSessionId);
    if (!scope) return;
    this.settleScope(scope);
  }

  /**
   * Settle every pending native callback as cancelled. Shutdown calls this
   * before discarding provider resources so no native waiter is left hanging.
   * Per-session close still uses `forgetSession`, which discards without settling.
   */
  cancelAllPending(): void {
    for (const scope of this.scopes.values()) {
      this.settleScope(scope);
    }
  }

  private settleScope(scope: InteractionScope): void {
    for (const pending of scope.approvals.values()) {
      pending.resolve(CANCEL_APPROVAL);
    }
    for (const pending of scope.questions.values()) {
      pending.resolve(CANCEL_QUESTION);
    }
    for (const pending of scope.planReviews.values()) {
      pending.resolve(CANCEL_PLAN_REVIEW);
    }
    scope.approvals.clear();
    scope.questions.clear();
    scope.planReviews.clear();
  }

  private hasPending(scope: InteractionScope, requestId: string): boolean {
    return (
      scope.approvals.has(requestId) ||
      scope.questions.has(requestId) ||
      scope.planReviews.has(requestId)
    );
  }

  private scope(appSessionId: string): InteractionScope {
    const existing = this.scopes.get(appSessionId);
    if (existing) return existing;
    const created: InteractionScope = {
      approvals: new Map(),
      questions: new Map(),
      planReviews: new Map(),
    };
    this.scopes.set(appSessionId, created);
    return created;
  }
}

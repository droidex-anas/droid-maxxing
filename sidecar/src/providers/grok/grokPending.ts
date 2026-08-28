import type {
  ProviderApprovalDecision,
  ProviderPlanReviewDecision,
  ProviderQuestionAnswer,
} from '../providerTypes.js';

export class OnceValue<T> {
  #settled = false;
  readonly promise: Promise<T>;
  readonly #resolve: (value: T) => void;

  constructor() {
    let resolve: (value: T) => void = () => undefined;
    this.promise = new Promise((next) => {
      resolve = next;
    });
    this.#resolve = resolve;
  }

  get settled(): boolean {
    return this.#settled;
  }

  settle(value: T): boolean {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.#resolve(value);
    return true;
  }
}

export class GrokPendingInteractions {
  readonly #approvals = new Map<string, OnceValue<ProviderApprovalDecision>>();
  readonly #questions = new Map<string, OnceValue<ProviderQuestionAnswer>>();
  readonly #planReviews = new Map<string, OnceValue<ProviderPlanReviewDecision>>();

  openApproval(requestId: string): OnceValue<ProviderApprovalDecision> {
    const pending = new OnceValue<ProviderApprovalDecision>();
    this.#approvals.set(requestId, pending);
    return pending;
  }

  openQuestion(requestId: string): OnceValue<ProviderQuestionAnswer> {
    const pending = new OnceValue<ProviderQuestionAnswer>();
    this.#questions.set(requestId, pending);
    return pending;
  }

  openPlanReview(requestId: string): OnceValue<ProviderPlanReviewDecision> {
    const pending = new OnceValue<ProviderPlanReviewDecision>();
    this.#planReviews.set(requestId, pending);
    return pending;
  }

  forget(requestId: string): void {
    this.#approvals.delete(requestId);
    this.#questions.delete(requestId);
    this.#planReviews.delete(requestId);
  }

  settleAllCancelled(): void {
    for (const pending of this.#approvals.values()) {
      pending.settle({ decision: 'cancel' });
    }
    for (const pending of this.#questions.values()) {
      pending.settle({ status: 'cancelled' });
    }
    for (const pending of this.#planReviews.values()) {
      pending.settle({ decision: 'cancel' });
    }
    this.#approvals.clear();
    this.#questions.clear();
    this.#planReviews.clear();
  }

  get hasOpen(): boolean {
    return this.#approvals.size > 0 || this.#questions.size > 0 || this.#planReviews.size > 0;
  }
}

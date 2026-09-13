import { isUnattendedAutomationSession } from './automations/AutomationManager.js';
import { shouldAutoApproveAutomationTool } from './automations/permissionPolicy.js';
import {
  isAlwaysOutcome,
  isApprovalOutcome,
  normalizePermissionOutcome,
} from './permissionOutcomes.js';
import type {
  PermissionKind,
  PermissionOutcome,
  ServerEvent,
  SessionQuestion,
  SessionSummary,
} from './protocol.js';
import {
  nextInteractionRequestId,
  type ProviderApprovalRequest,
  type ProviderInteractions,
  type ProviderQuestionAnswers,
} from './providers/interactions.js';
import { errMsg } from './sessionHelpers.js';

interface PendingPermission {
  resolve: (outcome: PermissionOutcome) => void;
  kind: PermissionKind;
  signature?: string;
}

interface InteractionScope {
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, (answers: ProviderQuestionAnswers) => void>;
  permissionGrants: Set<string>;
}

export interface InteractionLiveSession {
  summary: SessionSummary;
}

type InteractionError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionInteractionsDependencies {
  getLiveSession: (id: string) => InteractionLiveSession | undefined;
  updateSummary: (id: string, patch: Partial<SessionSummary>) => void;
  // Leaves spec mode on the provider so an approved plan runs in Auto.
  exitSpecModeForRun: (appSessionId: string) => Promise<void>;
  emit: (event: ServerEvent) => void;
  emitError: (error: InteractionError) => void;
}

export class SessionInteractions {
  private readonly scopes = new Map<string, InteractionScope>();

  constructor(private readonly dependencies: SessionInteractionsDependencies) {}

  interactionsFor(ref: { id: string }): ProviderInteractions {
    return {
      requestApproval: (approval) => this.decideApproval(ref.id, approval),
      requestQuestion: (questions) => this.askQuestion(ref.id, questions),
    };
  }

  private async decideApproval(
    sessionId: string,
    approval: ProviderApprovalRequest,
  ): Promise<PermissionOutcome> {
    const liveSession = this.dependencies.getLiveSession(sessionId);
    const autonomy = liveSession?.summary.autonomy;
    const tool = approval.automationTool;
    const safeForUnattended =
      tool !== undefined &&
      shouldAutoApproveAutomationTool(tool.serverName, tool.toolName, autonomy, true);
    const safeForInteractive =
      tool !== undefined &&
      shouldAutoApproveAutomationTool(tool.serverName, tool.toolName, autonomy);
    if (
      safeForUnattended ||
      (safeForInteractive &&
        !(await isUnattendedAutomationSession(liveSession?.summary.appSessionId)))
    ) {
      return 'proceed_once';
    }
    return await new Promise<PermissionOutcome>((resolve) => {
      const { request, signature } = approval;
      const scope = liveSession ? this.scope(liveSession.summary.appSessionId) : undefined;
      if (scope && signature && scope.permissionGrants.has(signature)) {
        resolve('proceed_always');
        return;
      }
      if (liveSession && scope) {
        scope.pendingPermissions.set(request.requestId, {
          resolve,
          kind: request.kind,
          ...(signature ? { signature } : {}),
        });
        if (approval.confirmationType === 'propose_mission') {
          this.dependencies.updateSummary(sessionId, {
            phase: 'awaiting_plan_approval',
            proposal: request.detail,
          });
        } else if (approval.confirmationType === 'start_mission_run') {
          this.dependencies.updateSummary(sessionId, { phase: 'awaiting_run_start' });
        }
      }
      this.dependencies.emit({ type: 'approval.requested', request });
    });
  }

  private askQuestion(
    sessionId: string,
    questions: SessionQuestion['questions'],
  ): Promise<ProviderQuestionAnswers> {
    return new Promise<ProviderQuestionAnswers>((resolve) => {
      const liveSession = this.dependencies.getLiveSession(sessionId);
      const requestId = nextInteractionRequestId();
      if (liveSession) {
        this.scope(liveSession.summary.appSessionId).pendingQuestions.set(requestId, resolve);
      }
      this.dependencies.emit({
        type: 'question.requested',
        question: { appSessionId: sessionId, requestId, questions },
      });
    });
  }

  async respondToApproval(appSessionId: string, requestId: string, outcome: string): Promise<void> {
    const liveSession = this.dependencies.getLiveSession(appSessionId);
    if (!liveSession) return;
    const scope = this.scopes.get(liveSession.summary.appSessionId);
    const pending = scope?.pendingPermissions.get(requestId);
    if (!scope || !pending) return;
    scope.pendingPermissions.delete(requestId);
    let normalized: PermissionOutcome;
    try {
      normalized = normalizePermissionOutcome(outcome);
    } catch (error) {
      this.dependencies.emitError({
        code: 'permission.invalid_outcome',
        appSessionId,
        message: errMsg(error),
      });
      normalized = 'cancel';
    }
    if (pending.signature && isAlwaysOutcome(outcome)) {
      scope.permissionGrants.add(pending.signature);
    }
    if (pending.kind === 'spec' && isApprovalOutcome(normalized)) {
      await this.prepareSpecExitForRun(liveSession.summary.appSessionId);
    }
    pending.resolve(normalized);
  }

  respondToQuestion(
    appSessionId: string,
    requestId: string,
    cancelled: boolean,
    answers: { index: number; question: string; answer: string }[],
  ): void {
    const liveSession = this.dependencies.getLiveSession(appSessionId);
    if (!liveSession) return;
    const scope = this.scopes.get(liveSession.summary.appSessionId);
    const resolve = scope?.pendingQuestions.get(requestId);
    if (!scope || !resolve) return;
    scope.pendingQuestions.delete(requestId);
    resolve({ cancelled, answers });
  }

  forgetSession(appSessionId: string): void {
    this.scopes.delete(appSessionId);
  }

  private scope(appSessionId: string): InteractionScope {
    const existing = this.scopes.get(appSessionId);
    if (existing) return existing;
    const created: InteractionScope = {
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      permissionGrants: new Set(),
    };
    this.scopes.set(appSessionId, created);
    return created;
  }

  private async prepareSpecExitForRun(appSessionId: string): Promise<void> {
    try {
      this.dependencies.updateSummary(appSessionId, {
        interactionMode: 'auto',
        phase: 'running',
      });
      await this.dependencies.exitSpecModeForRun(appSessionId);
    } catch (error) {
      this.dependencies.emitError({
        code: 'spec.exit_failed',
        appSessionId,
        message: `Could not switch spec session to Auto before run: ${errMsg(error)}`,
      });
    }
  }
}

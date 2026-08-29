import {
  DroidInteractionMode,
  type AskUserHandler,
  type AskUserRequestParams,
  type AskUserResult,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
  type UpdateSessionSettingsRequestParams,
} from '@factory/droid-sdk';

import { isApprovalOutcome, normalizePermissionOutcome } from '../../permissionOutcomes.js';
import type { ServerEvent, SessionSummary } from '../../protocol.js';
import { errMsg } from '../../sessionHelpers.js';
import type { ProviderInstanceId, SessionTarget } from '../providerIdentity.js';
import type {
  ProviderApprovalDecision,
  ProviderInteractionSink,
  ProviderQuestionAnswer,
  ProviderSession,
} from '../providerTypes.js';
import { requireDroidExtension } from './droidCapabilityGate.js';
import { APPROVAL_DECISION_TO_OUTCOME } from './DroidModeMapping.js';
import { classifyPermission, confirmationType, permissionSignature } from './DroidPermissions.js';

export interface DroidInteractionLiveSession {
  summary: SessionSummary;
  provider: ProviderSession;
  binding: { providerInstanceId: ProviderInstanceId };
  session: {
    updateSettings: (settings: Partial<UpdateSessionSettingsRequestParams>) => Promise<unknown>;
  };
  runtimeGeneration: number;
  markConfigurationApplied?: () => void;
}

type InteractionError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface DroidInteractionsDependencies {
  sink: ProviderInteractionSink;
  getLiveSession: (id: string) => DroidInteractionLiveSession | undefined;
  updateSummary: (id: string, patch: Partial<SessionSummary>) => void;
  emitError: (error: InteractionError) => void;
}

export interface DroidNativeHandlerHost {
  runtimeGeneration: number;
  runNativeCallback<T>(work: () => Promise<T>): Promise<T>;
  createInput: {
    target: SessionTarget;
    ids: { nextEventId(): string };
    interactionSink: ProviderInteractionSink;
  };
}

let requestSequence = 0;
const nextNativeRequestId = () =>
  `req-${Date.now().toString(36)}-${(requestSequence++).toString(36)}`;

export class DroidInteractions {
  private readonly grants = new Map<string, Set<string>>();
  private readonly mappingTasks = new Set<Promise<void>>();

  constructor(private readonly dependencies: DroidInteractionsDependencies) {}

  async drain(): Promise<void> {
    await Promise.resolve();
    if (this.mappingTasks.size === 0) return;
    await Promise.all([...this.mappingTasks]);
  }

  makePermissionHandler(ref: { id: string }): PermissionHandler {
    return (params) => this.handleLifecyclePermission(ref, params);
  }

  makeAskUserHandler(ref: { id: string }): AskUserHandler {
    return (params) => this.handleLifecycleQuestion(ref, params);
  }

  forgetSession(appSessionId: string): void {
    this.grants.delete(appSessionId);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    this.mappingTasks.add(tracked);
    void tracked.finally(() => {
      this.mappingTasks.delete(tracked);
    });
    return work;
  }

  private async handleLifecyclePermission(
    ref: { id: string },
    params: RequestPermissionRequestParams,
  ): Promise<RequestPermissionHandlerResult> {
    const liveSession = this.dependencies.getLiveSession(ref.id);
    const appSessionId = liveSession?.summary.appSessionId ?? ref.id;
    const classified = classifyPermission(params);
    const type = confirmationType(params);
    const signature = permissionSignature(params);
    if (signature && this.sessionGrants(appSessionId).has(signature)) {
      return normalizePermissionOutcome('proceed_always');
    }
    if (liveSession) {
      if (type === 'propose_mission') {
        this.dependencies.updateSummary(appSessionId, {
          phase: 'awaiting_plan_approval',
          proposal: classified.detail,
        });
      } else if (type === 'start_mission_run') {
        this.dependencies.updateSummary(appSessionId, { phase: 'awaiting_run_start' });
      }
    }
    const decision = await this.dependencies.sink.requestApproval({
      requestId: nextNativeRequestId(),
      target: { kind: 'session', appSessionId },
      runtimeGeneration: liveSession?.runtimeGeneration ?? 0,
      kind: classified.kind,
      title: classified.title,
      detail: classified.detail,
      ...(classified.plan !== undefined ? { plan: classified.plan } : {}),
      ...(classified.options !== undefined ? { options: classified.options } : {}),
    });
    return await this.track(
      this.applyLifecycleDecision(appSessionId, liveSession, classified.kind, signature, decision),
    );
  }

  private async handleLifecycleQuestion(
    ref: { id: string },
    params: AskUserRequestParams,
  ): Promise<AskUserResult> {
    const liveSession = this.dependencies.getLiveSession(ref.id);
    const appSessionId = liveSession?.summary.appSessionId ?? ref.id;
    const mapped = droidQuestionsFromParams(params);
    const answer = await this.dependencies.sink.requestQuestion({
      requestId: nextNativeRequestId(),
      target: { kind: 'session', appSessionId },
      runtimeGeneration: liveSession?.runtimeGeneration ?? 0,
      questions: mapped.canonical,
    });
    return await this.track(Promise.resolve(reconstructAskUserResult(mapped.native, answer)));
  }

  private async applyLifecycleDecision(
    appSessionId: string,
    liveSession: DroidInteractionLiveSession | undefined,
    kind: ReturnType<typeof classifyPermission>['kind'],
    signature: string,
    decision: ProviderApprovalDecision,
  ): Promise<RequestPermissionHandlerResult> {
    if (signature && decision.decision === 'allow_session') {
      this.sessionGrants(appSessionId).add(signature);
    }
    if (kind === 'spec' && isApprovedDecision(decision) && liveSession) {
      await this.prepareSpecExitForRun(liveSession);
    }
    return factoryOutcomeFromDecision(decision);
  }

  private sessionGrants(appSessionId: string): Set<string> {
    const existing = this.grants.get(appSessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.grants.set(appSessionId, created);
    return created;
  }

  private async prepareSpecExitForRun(liveSession: DroidInteractionLiveSession): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    try {
      this.dependencies.updateSummary(appSessionId, {
        configuration: {
          ...liveSession.summary.configuration,
          interactionMode: 'auto',
        },
        phase: 'running',
      });
      liveSession.markConfigurationApplied?.();
      await requireDroidExtension(
        liveSession.provider,
        'updateSettings',
        liveSession.binding.providerInstanceId,
      ).updateSettings({
        interactionMode: DroidInteractionMode.Auto,
      });
    } catch (error) {
      this.dependencies.emitError({
        code: 'spec.exit_failed',
        appSessionId,
        message: `Could not switch spec session to Auto before run: ${errMsg(error)}`,
      });
    }
  }
}

export function createDroidNativeHandlers(host: DroidNativeHandlerHost): {
  permissionHandler: PermissionHandler;
  askUserHandler: AskUserHandler;
} {
  return {
    permissionHandler: (params) =>
      host.runNativeCallback(async () => {
        const requestId = host.createInput.ids.nextEventId();
        const classified = classifyPermission(params);
        const type = confirmationType(params);
        if (type === 'exit_spec_mode' || type === 'propose_mission') {
          const decision = await host.createInput.interactionSink.requestPlanReview({
            requestId,
            target: host.createInput.target,
            runtimeGeneration: host.runtimeGeneration,
            plan: classified.plan ?? classified.detail,
          });
          return normalizePermissionOutcome(
            decision.decision === 'implement' ? 'proceed_once' : 'cancel',
          );
        }
        const decision = await host.createInput.interactionSink.requestApproval({
          requestId,
          target: host.createInput.target,
          runtimeGeneration: host.runtimeGeneration,
          kind: classified.kind,
          title: classified.title,
          detail: classified.detail,
          ...(classified.plan !== undefined ? { plan: classified.plan } : {}),
          ...(classified.options !== undefined ? { options: classified.options } : {}),
        });
        return factoryOutcomeFromDecision(decision);
      }),
    askUserHandler: (params) =>
      host.runNativeCallback(async () => {
        const requestId = host.createInput.ids.nextEventId();
        const mapped = droidQuestionsFromParams(params);
        const answer = await host.createInput.interactionSink.requestQuestion({
          requestId,
          target: host.createInput.target,
          runtimeGeneration: host.runtimeGeneration,
          questions: mapped.canonical,
        });
        return reconstructAskUserResult(mapped.native, answer);
      }),
  };
}

function factoryOutcomeFromDecision(
  decision: ProviderApprovalDecision,
): RequestPermissionHandlerResult {
  if (decision.decision === 'option') return normalizePermissionOutcome(decision.option);
  const row = APPROVAL_DECISION_TO_OUTCOME.find((entry) => entry.decision === decision.decision);
  return normalizePermissionOutcome(row?.outcome ?? 'cancel');
}

function isApprovedDecision(decision: ProviderApprovalDecision): boolean {
  if (decision.decision === 'cancel' || decision.decision === 'deny') return false;
  if (decision.decision === 'option') return isApprovalOutcome(decision.option);
  return true;
}

interface NativeQuestion {
  index: number;
  question: string;
  options: string[];
}

function droidQuestionsFromParams(params: AskUserRequestParams): {
  native: NativeQuestion[];
  canonical: {
    id: string;
    prompt: string;
    options: string[];
    multiSelect: boolean;
  }[];
} {
  const runtimeParams: {
    questions?: { index: number; question: string; options?: string[] }[];
  } = params;
  const native = (runtimeParams.questions ?? []).map((question) => ({
    index: question.index,
    question: question.question,
    options: question.options ?? [],
  }));
  return {
    native,
    canonical: native.map((question) => ({
      id: String(question.index),
      prompt: question.question,
      options: question.options,
      multiSelect: false,
    })),
  };
}

function reconstructAskUserResult(
  native: readonly NativeQuestion[],
  answer: ProviderQuestionAnswer,
): AskUserResult {
  if (answer.status === 'cancelled') return { cancelled: true, answers: [] };
  return {
    cancelled: false,
    answers: native.map((question) => ({
      index: question.index,
      question: question.question,
      answer: answer.answers[String(question.index)]?.[0] ?? '',
    })),
  };
}

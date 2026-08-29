// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import { permissionKindFromAcpToolKind } from '../acp/acpPermissionKind.js';
import {
  decideToolCallUpdateEmission,
  mergeToolCallState,
  parseToolCallUpdate,
  toolCallProgressLength,
  type AcpToolCallState,
} from '../acp/acpSessionUpdate.js';
import type { ProviderRuntimeEvent } from '../providerEvents.js';
import {
  createProviderContractError,
  type ProviderApprovalDecision,
  type ProviderSessionCreateInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import {
  extractXaiExitPlanMarkdown,
  grokQuestionsForSink,
  makeXaiAskUserQuestionCancelledResponse,
  makeXaiAskUserQuestionResponse,
  makeXaiExitPlanModeCapturedResponse,
  parseXaiPromptComplete,
  unwrapAskUserQuestionParams,
  unwrapExitPlanModeParams,
} from './grokExtensions.js';
import { GrokPendingInteractions } from './grokPending.js';
import { grokPermissionFingerprint, selectGrokPermissionOptionId } from './grokPermissions.js';
import { nextGrokPlanModeActive, shouldEmitPlanBody } from './grokPlanMode.js';
import type { GrokTurnWatchdog } from './grokWatchdog.js';

type ActiveTurn = {
  turnId: string;
  runtimeGeneration: number;
  interrupting: boolean;
  settled: boolean;
};

type ToolCallTrack = {
  state: AcpToolCallState;
  lastEmittedDetailLength: number | undefined;
  skippedSinceEmit: number;
};

const permissionOptionSchema = z
  .object({ optionId: z.string().min(1), kind: z.string() })
  .passthrough();

const permissionRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    toolCall: z
      .object({
        toolCallId: z.string().min(1),
        title: z.string().optional(),
        kind: z.string().optional(),
        rawInput: z.unknown().optional(),
        locations: z.unknown().optional(),
      })
      .passthrough(),
    options: z.array(permissionOptionSchema),
  })
  .passthrough();

export interface GrokAcpHost {
  readonly input: ProviderSessionCreateInput;
  readonly runtimeGeneration: number;
  readonly pending: GrokPendingInteractions;
  readonly watchdog: GrokTurnWatchdog;
  readonly approvedOperations: Set<string>;
  activeTurn(): ActiveTurn | undefined;
  emit(event: ProviderRuntimeEvent): boolean;
  baseEvent(turnId?: string): {
    eventId: string;
    target: ProviderRuntimeEvent['target'];
    providerDriverKind: ProviderRuntimeEvent['providerDriverKind'];
    providerInstanceId: ProviderRuntimeEvent['providerInstanceId'];
    runtimeGeneration: number;
    createdAt: number;
    turnId?: string;
  };
  settleTurn(turnId: string, runtimeGeneration: number, settlement: ProviderTurnSettlement): void;
  settleFromPrompt(turnId: string, runtimeGeneration: number, result: unknown): void;
}

export class GrokSessionAcp {
  #planModeActive = false;
  #lastPlanBody: string | undefined;
  #lastPlanTurnId: string | undefined;
  readonly #toolCalls = new Map<string, ToolCallTrack>();
  readonly #host: GrokAcpHost;

  constructor(host: GrokAcpHost) {
    this.#host = host;
  }

  resetTurn(): void {
    this.#lastPlanBody = undefined;
    this.#lastPlanTurnId = undefined;
    this.#planModeActive = false;
    this.#toolCalls.clear();
  }

  onToolCallParams(params: unknown): void {
    const toolCall = parseToolCallUpdate(params);
    if (toolCall) {
      this.onToolCall(toolCall);
    }
  }

  onToolCall(next: AcpToolCallState): void {
    const previous = this.#toolCalls.get(next.toolCallId);
    const merged = mergeToolCallState(previous?.state, next);
    const decision = decideToolCallUpdateEmission({
      previous: previous?.state,
      next: merged,
      lastEmittedDetailLength: previous?.lastEmittedDetailLength,
      skippedSinceEmit: previous?.skippedSinceEmit ?? 0,
    });
    const terminal = merged.status === 'completed' || merged.status === 'failed';
    this.#host.watchdog.setToolActive(merged.toolCallId, !terminal && merged.status !== undefined);
    this.#host.watchdog.recordActivity();
    this.#planModeActive = nextGrokPlanModeActive(this.#planModeActive, merged);
    this.#toolCalls.set(next.toolCallId, {
      state: merged,
      lastEmittedDetailLength: decision.emit
        ? toolCallProgressLength(merged)
        : previous?.lastEmittedDetailLength,
      skippedSinceEmit: decision.skippedSinceEmit,
    });
    if (!decision.emit) {
      return;
    }
    this.#host.emit({
      ...this.#host.baseEvent(this.#host.activeTurn()?.turnId),
      type: 'transcript',
      event: {
        role: 'primary',
        kind: terminal ? 'tool_result' : 'tool_call',
        text: merged.detail ?? merged.title ?? merged.toolCallId,
        toolName: merged.title,
        toolUseId: merged.toolCallId,
        toolArgs: merged.data?.rawInput,
        isError: merged.status === 'failed',
      },
    });
  }

  async onPermission(params: unknown): Promise<unknown> {
    const parsed = permissionRequestSchema.safeParse(params);
    if (!parsed.success) {
      throw grokError(
        'incompatible_provider_protocol',
        'Grok permission request was malformed.',
        'retry_session',
      );
    }
    const toolCall = parsed.data.toolCall;
    const command = commandFromRawInput(toolCall.rawInput);
    const fingerprint = grokPermissionFingerprint({
      kind: toolCall.kind,
      title: toolCall.title,
      command,
      rawInput: toolCall.rawInput,
      locations: toolCall.locations,
    });
    const options = parsed.data.options.map((entry) => ({
      optionId: entry.optionId,
      kind: entry.kind,
    }));
    const auto =
      this.#host.input.configuration.autonomy === 'high' ||
      (fingerprint !== undefined && this.#host.approvedOperations.has(fingerprint));
    if (auto) {
      const optionId =
        this.#host.input.configuration.autonomy === 'high'
          ? (selectGrokPermissionOptionId(options, 'allow_session') ??
            selectGrokPermissionOptionId(options, 'allow_once'))
          : selectGrokPermissionOptionId(options, 'allow_once');
      if (optionId) {
        return { outcome: { outcome: 'selected', optionId } };
      }
    }
    const requestId = this.#host.input.ids.nextEventId();
    const pending = this.#host.pending.openApproval(requestId);
    this.#host.watchdog.pause();
    void this.#host.input.interactionSink
      .requestApproval({
        requestId,
        target: this.#host.input.target,
        runtimeGeneration: this.#host.runtimeGeneration,
        kind: permissionKindFromAcpToolKind(toolCall.kind),
        title: toolCall.title?.trim() || 'Permission request',
        detail: command ?? toolCall.title ?? 'Grok requested permission.',
      })
      .then(
        (decision) => pending.settle(decision),
        () => pending.settle({ decision: 'cancel' }),
      );
    const decision = await pending.promise;
    this.#host.pending.forget(requestId);
    this.#host.watchdog.resume();
    return permissionOutcome(options, decision, fingerprint, this.#host.approvedOperations);
  }

  async onQuestion(params: unknown): Promise<unknown> {
    const parsed = unwrapAskUserQuestionParams(params);
    if (!parsed) {
      throw grokError(
        'incompatible_provider_protocol',
        'Grok question request was malformed.',
        'retry_session',
      );
    }
    const requestId = this.#host.input.ids.nextEventId();
    const pending = this.#host.pending.openQuestion(requestId);
    this.#host.watchdog.pause();
    void this.#host.input.interactionSink
      .requestQuestion({
        requestId,
        target: this.#host.input.target,
        runtimeGeneration: this.#host.runtimeGeneration,
        questions: grokQuestionsForSink(parsed),
      })
      .then(
        (answer) => pending.settle(answer),
        () => pending.settle({ status: 'cancelled' }),
      );
    const answer = await pending.promise;
    this.#host.pending.forget(requestId);
    this.#host.watchdog.resume();
    if (answer.status === 'cancelled') {
      return makeXaiAskUserQuestionCancelledResponse();
    }
    return makeXaiAskUserQuestionResponse(parsed, answer.answers);
  }

  async onExitPlanMode(params: unknown): Promise<unknown> {
    const parsed = unwrapExitPlanModeParams(params);
    if (!parsed) {
      throw grokError(
        'incompatible_provider_protocol',
        'Grok plan request was malformed.',
        'retry_session',
      );
    }
    const turnId = this.#host.activeTurn()?.turnId ?? '';
    const plan = extractXaiExitPlanMarkdown(parsed, this.#lastPlanBody);
    this.#planModeActive = false;
    if (
      shouldEmitPlanBody({
        lastBody: this.#lastPlanBody,
        lastTurnId: this.#lastPlanTurnId,
        turnId,
        body: plan,
      })
    ) {
      this.#lastPlanBody = plan.trim();
      this.#lastPlanTurnId = turnId;
      void this.#offerPlanReview(plan);
    }
    return makeXaiExitPlanModeCapturedResponse();
  }

  onPromptComplete(params: unknown): void {
    const parsed = parseXaiPromptComplete(params);
    if (!parsed) {
      return;
    }
    const active = this.#host.activeTurn();
    if (!active || active.settled) {
      return;
    }
    if (parsed.stopReason === 'rate_limit') {
      this.#host.settleTurn(active.turnId, active.runtimeGeneration, {
        status: 'failed',
        error: grokError(
          'unavailable_provider_instance',
          'Grok usage limit reached. Try again later.',
          'refresh',
        ).toProviderError(),
      });
      return;
    }
    if (parsed.stopReason === 'cancelled') {
      this.#host.settleTurn(active.turnId, active.runtimeGeneration, { status: 'cancelled' });
      return;
    }
    this.#host.settleFromPrompt(active.turnId, active.runtimeGeneration, {
      stopReason: parsed.stopReason ?? 'end_turn',
    });
  }

  async #offerPlanReview(plan: string): Promise<void> {
    const requestId = this.#host.input.ids.nextEventId();
    const pending = this.#host.pending.openPlanReview(requestId);
    this.#host.watchdog.pause();
    void this.#host.input.interactionSink
      .requestPlanReview({
        requestId,
        target: this.#host.input.target,
        runtimeGeneration: this.#host.runtimeGeneration,
        plan,
      })
      .then(
        (decision) => pending.settle(decision),
        () => pending.settle({ decision: 'cancel' }),
      );
    await pending.promise;
    this.#host.pending.forget(requestId);
    this.#host.watchdog.resume();
  }
}

function permissionOutcome(
  options: readonly { optionId: string; kind: string }[],
  decision: ProviderApprovalDecision,
  fingerprint: string | undefined,
  approvedOperations: Set<string>,
): unknown {
  if (decision.decision === 'cancel') {
    return { outcome: { outcome: 'cancelled' } };
  }
  if (decision.decision === 'option') {
    return { outcome: { outcome: 'selected', optionId: decision.option } };
  }
  const mapped =
    decision.decision === 'allow_session'
      ? 'allow_session'
      : decision.decision === 'allow_once'
        ? 'allow_once'
        : 'deny';
  const optionId = selectGrokPermissionOptionId(options, mapped);
  if (mapped === 'allow_session' && optionId && fingerprint) {
    approvedOperations.add(fingerprint);
  }
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function commandFromRawInput(rawInput: unknown): string | undefined {
  if (
    typeof rawInput === 'object' &&
    rawInput !== null &&
    'command' in rawInput &&
    typeof rawInput.command === 'string'
  ) {
    return rawInput.command;
  }
  return undefined;
}

function grokError(
  code: 'incompatible_provider_protocol' | 'unavailable_provider_instance',
  message: string,
  recoveryAction: 'retry_session' | 'refresh',
) {
  return createProviderContractError('grok', code, message, recoveryAction);
}

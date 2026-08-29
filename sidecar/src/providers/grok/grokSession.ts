// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import type { AcpNotification, AcpServerRequest } from '../acp/AcpConnection.js';
import { AcpConnectionError } from '../acp/acpConnectionErrors.js';
import { AcpPreActivationBuffer } from '../acp/acpPreActivation.js';
import { followAcpPrompt } from '../acp/acpPromptFollow.js';
import { parseAssistantTextDelta, sessionUpdateIsReplay } from '../acp/acpSessionUpdate.js';
import { admitProviderRuntimeEvent, type ProviderRuntimeEvent } from '../providerEvents.js';
import type { ProviderError } from '../providerErrors.js';
import {
  ProviderContractError,
  createProviderContractError,
  type ProviderSession,
  type ProviderSessionCreateInput,
  type ProviderSteerInput,
  type ProviderTurnInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  isXaiAskUserQuestionMethod,
  isXaiExitPlanModeMethod,
  isXaiPromptCompleteMethod,
  XAI_RATE_LIMITED_RPC_CODE,
} from './grokExtensions.js';
import {
  encodeGrokResumeState,
  GROK_DEFINITION,
  isValidGrokModelToken,
  resolveGrokAcpBaseModelId,
  type GrokResumeState,
} from './grokHandshake.js';
import { GrokPendingInteractions } from './grokPending.js';
import { GrokSessionAcp } from './grokSessionAcp.js';
import { createRealGrokTimer, GrokTurnWatchdog, type GrokTimer } from './grokWatchdog.js';

export interface GrokAcpClient {
  readonly sessionId: string;
  readonly sessionSetupResult: unknown;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  prompt(blocks: readonly unknown[]): Promise<unknown>;
  cancel(): void;
  close(deadline: ShutdownDeadline): Promise<void>;
}

type SessionPhase =
  | { kind: 'pending'; buffer: AcpPreActivationBuffer }
  | { kind: 'active' }
  | { kind: 'closed'; reason: 'overflow' | 'close' };

type ActiveTurn = {
  turnId: string;
  runtimeGeneration: number;
  interrupting: boolean;
  settled: boolean;
};

export interface GrokSessionOptions {
  providerSessionId: string;
  resumeState?: GrokResumeState;
  timer?: GrokTimer;
  inactivityMs?: number;
  activeToolInactivityMs?: number;
}

export class GrokProviderSession implements ProviderSession {
  readonly providerSessionId: string;
  discardedCount = 0;
  nativeCallbacksSettled = false;
  receivedCloseDeadline: ShutdownDeadline | undefined;
  readonly openError = createProviderContractError(
    'grok',
    'native_session_start_failed',
    'pre-activation buffer overflow',
    'retry_session',
  );

  #phase: SessionPhase = { kind: 'pending', buffer: new AcpPreActivationBuffer() };
  #connection: GrokAcpClient | undefined;
  #activeTurn: ActiveTurn | undefined;
  #storedResumeState: unknown;
  readonly #settledTurns = new Set<string>();
  readonly #approvedOperations = new Set<string>();
  readonly #pending = new GrokPendingInteractions();
  readonly #watchdog: GrokTurnWatchdog;
  readonly #acp: GrokSessionAcp;
  readonly #input: ProviderSessionCreateInput;
  readonly #runtimeGeneration: number;
  readonly #timer: GrokTimer;

  constructor(input: ProviderSessionCreateInput, options: GrokSessionOptions) {
    this.#input = input;
    this.#runtimeGeneration = input.expectedGeneration;
    this.providerSessionId = options.providerSessionId;
    this.#storedResumeState = options.resumeState;
    this.#timer = options.timer ?? createRealGrokTimer();
    this.#watchdog = new GrokTurnWatchdog({
      timer: this.#timer,
      inactivityMs: options.inactivityMs,
      activeToolInactivityMs: options.activeToolInactivityMs,
      remainingMs: () => this.receivedCloseDeadline?.remainingMs(this.#timer.now()) ?? Infinity,
      onStall: (turnId) => this.#stallTurn(turnId),
    });
    this.#acp = new GrokSessionAcp({
      input: this.#input,
      runtimeGeneration: this.#runtimeGeneration,
      pending: this.#pending,
      watchdog: this.#watchdog,
      approvedOperations: this.#approvedOperations,
      activeTurn: () => this.#activeTurn,
      emit: (event) => this.#emit(event),
      baseEvent: (turnId) => this.#baseEvent(turnId),
      settleTurn: (turnId, generation, settlement) =>
        this.#settleTurn(turnId, generation, settlement),
      settleFromPrompt: (turnId, generation, result) =>
        this.#settleFromPrompt(turnId, generation, result),
    });
  }

  get initialResumeState(): unknown {
    return this.#storedResumeState;
  }

  get failedOpen(): boolean {
    return this.#phase.kind === 'closed' && this.#phase.reason === 'overflow';
  }

  get isClosed(): boolean {
    return this.#phase.kind === 'closed';
  }

  get laterEventsAccepted(): boolean {
    return this.#phase.kind === 'pending' || this.#phase.kind === 'active';
  }

  get bufferedEventCount(): number {
    return this.#phase.kind === 'pending' ? this.#phase.buffer.size : 0;
  }

  bindConnection(connection: GrokAcpClient): void {
    this.#connection = connection;
    const resumeState = encodeGrokResumeState(connection.sessionId);
    this.#storedResumeState = resumeState;
    this.#emit({
      ...this.#baseEvent(),
      type: 'binding.updated',
      binding: { providerSessionId: this.providerSessionId, resumeState },
    });
  }

  onAcpNotification(notification: AcpNotification): void {
    if (isXaiPromptCompleteMethod(notification.method)) {
      this.#acp.onPromptComplete(notification.params);
      return;
    }
    if (notification.method !== 'session/update' || sessionUpdateIsReplay(notification.params)) {
      return;
    }
    const delta = parseAssistantTextDelta(notification.params);
    if (delta) {
      this.#watchdog.recordActivity();
      this.#emit({
        ...this.#baseEvent(this.#activeTurn?.turnId),
        type: 'transcript',
        event: { role: 'primary', kind: 'text', text: delta.text },
      });
      return;
    }
    this.#acp.onToolCallParams(notification.params);
  }

  async onAcpServerRequest(request: AcpServerRequest): Promise<unknown> {
    if (request.method === 'session/request_permission') {
      return this.#acp.onPermission(request.params);
    }
    if (isXaiAskUserQuestionMethod(request.method)) {
      return this.#acp.onQuestion(request.params);
    }
    if (isXaiExitPlanModeMethod(request.method)) {
      return this.#acp.onExitPlanMode(request.params);
    }
    throw grokError('unsupported_capability', 'Unknown ACP method.', 'refresh');
  }

  activate(): void {
    if (this.#phase.kind === 'closed') {
      throw this.#phase.reason === 'overflow'
        ? this.openError
        : grokError('stale_provider_operation', 'activate is one-shot', 'close_session');
    }
    if (this.#phase.kind === 'active') {
      throw grokError('stale_provider_operation', 'activate is one-shot', 'close_session');
    }
    const buffered = this.#phase.buffer.drain();
    this.#phase = { kind: 'active' };
    for (const event of buffered) {
      this.#deliverIfAdmitted(event);
    }
  }

  async startTurn(input: ProviderTurnInput): Promise<void> {
    const runtimeGeneration = this.#runtimeGeneration;
    const turnId = input.turnId;
    const connection = this.#requireConnection();
    this.#assertActive();
    const modelId = resolveGrokAcpBaseModelId(input.configuration.providerSelection.modelId);
    if (!isValidGrokModelToken(modelId)) {
      throw grokError('invalid_provider_configuration', 'Grok model id is invalid.', 'refresh');
    }
    const effortRaw = input.configuration.providerSelection.options.reasoningEffort;
    const reasoningEffort =
      typeof effortRaw === 'string' && isValidGrokModelToken(effortRaw) ? effortRaw : undefined;
    await connection.request('session/set_model', {
      sessionId: connection.sessionId,
      modelId,
      ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
    });
    this.#revalidate(runtimeGeneration);
    this.#acp.resetTurn();
    this.#activeTurn = { turnId, runtimeGeneration, interrupting: false, settled: false };
    this.#watchdog.start(turnId);
    const promptPromise = connection.prompt([{ type: 'text', text: input.prompt.text }]);
    followAcpPrompt(promptPromise, {
      onResult: (result) => this.#settleFromPrompt(turnId, runtimeGeneration, result),
      onError: (error) => this.#settleFromPromptFailure(turnId, runtimeGeneration, error),
    });
  }

  async steer(_input: ProviderSteerInput): Promise<void> {
    throw grokError('unsupported_capability', 'Grok steer is not implemented.', 'refresh');
  }

  async interrupt(input: { turnId: string; runtimeGeneration: number }): Promise<void> {
    const runtimeGeneration = this.#runtimeGeneration;
    this.#assertActive();
    if (input.runtimeGeneration !== runtimeGeneration) {
      throw grokError(
        'stale_provider_operation',
        'interrupt generation does not match the live session',
        'retry_session',
      );
    }
    const active = this.#activeTurn;
    if (!active || active.turnId !== input.turnId || active.settled) {
      throw grokError(
        'stale_provider_operation',
        'interrupt does not match the in-flight turn',
        'retry_session',
      );
    }
    active.interrupting = true;
    this.#pending.settleAllCancelled();
    this.#connection?.cancel();
    this.#watchdog.stop();
    this.#settleTurn(active.turnId, runtimeGeneration, { status: 'interrupted' });
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.receivedCloseDeadline = deadline;
    if (this.#phase.kind === 'closed') {
      this.nativeCallbacksSettled = true;
      return;
    }
    if (this.#phase.kind === 'pending') {
      this.discardedCount = this.#phase.buffer.size;
    }
    this.#pending.settleAllCancelled();
    this.#watchdog.stop();
    const active = this.#activeTurn;
    if (active && !active.settled && this.#phase.kind === 'active') {
      this.#settleTurn(active.turnId, this.#runtimeGeneration, { status: 'cancelled' });
    }
    this.#phase = { kind: 'closed', reason: 'close' };
    await this.#closeConnection(deadline);
  }

  #settleFromPrompt(turnId: string, runtimeGeneration: number, result: unknown): void {
    const active = this.#activeTurn;
    if (!active || active.turnId !== turnId || active.settled) {
      return;
    }
    if (runtimeGeneration !== this.#runtimeGeneration || this.#phase.kind === 'closed') {
      return;
    }
    if (active.interrupting) {
      this.#settleTurn(turnId, runtimeGeneration, { status: 'interrupted' });
      return;
    }
    const stopReason = readStopReason(result);
    this.#settleTurn(
      turnId,
      runtimeGeneration,
      stopReason === 'cancelled' ? { status: 'cancelled' } : { status: 'completed' },
    );
  }

  #settleFromPromptFailure(turnId: string, runtimeGeneration: number, error: unknown): void {
    const active = this.#activeTurn;
    if (!active || active.turnId !== turnId || active.settled) {
      return;
    }
    if (runtimeGeneration !== this.#runtimeGeneration || this.#phase.kind === 'closed') {
      return;
    }
    if (active.interrupting) {
      this.#settleTurn(turnId, runtimeGeneration, { status: 'interrupted' });
      return;
    }
    this.#pending.settleAllCancelled();
    this.#watchdog.stop();
    this.#settleTurn(turnId, runtimeGeneration, {
      status: 'failed',
      error: mapSessionError(error),
    });
  }

  #stallTurn(turnId: string): void {
    const active = this.#activeTurn;
    if (!active || active.turnId !== turnId || active.settled) {
      return;
    }
    this.#pending.settleAllCancelled();
    this.#connection?.cancel();
    this.#watchdog.stop();
    this.#settleTurn(turnId, this.#runtimeGeneration, {
      status: 'failed',
      error: grokError(
        'unavailable_provider_instance',
        'Grok ACP turn stalled without content or tool progress.',
        'retry_session',
      ).toProviderError(),
    });
  }

  #settleTurn(turnId: string, runtimeGeneration: number, settlement: ProviderTurnSettlement): void {
    // session/prompt and the xAI prompt-complete notification both call here; first arrival wins.
    if (this.#settledTurns.has(turnId) || runtimeGeneration !== this.#runtimeGeneration) {
      return;
    }
    this.#watchdog.stop();
    const emitted = this.#emit({
      ...this.#baseEvent(turnId),
      nativeCorrelation: { sessionId: this.#connection?.sessionId, turnId },
      type: 'turn.settled',
      settlement,
    });
    if (emitted || this.#phase.kind === 'closed') {
      this.#settledTurns.add(turnId);
      if (this.#activeTurn?.turnId === turnId) {
        this.#activeTurn.settled = true;
      }
    }
  }

  #emit(event: ProviderRuntimeEvent): boolean {
    if (this.#phase.kind === 'closed') {
      return false;
    }
    const admitted = admitProviderRuntimeEvent(event, this.#live());
    if (!admitted.ok) {
      return false;
    }
    if (this.#phase.kind === 'pending') {
      if (!this.#phase.buffer.tryPush(event)) {
        this.discardedCount = this.#phase.buffer.size;
        this.#phase = { kind: 'closed', reason: 'overflow' };
        void this.#closeConnection(undefined);
        return false;
      }
      return true;
    }
    this.#deliver(event);
    return true;
  }

  #deliverIfAdmitted(event: ProviderRuntimeEvent): void {
    if (admitProviderRuntimeEvent(event, this.#live()).ok) {
      this.#deliver(event);
    }
  }

  #deliver(event: ProviderRuntimeEvent): void {
    this.#input.eventSink(event);
    if (event.type === 'turn.settled' && event.turnId !== undefined) {
      this.#settledTurns.add(event.turnId);
    }
  }

  async #closeConnection(deadline: ShutdownDeadline | undefined): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) {
      await connection.close(deadline ?? ShutdownDeadline.fromDurationMs(0));
    }
    this.nativeCallbacksSettled = true;
  }

  #requireConnection(): GrokAcpClient {
    const connection = this.#connection;
    if (!connection) {
      throw grokError(
        'stale_provider_operation',
        'Grok session has no ACP connection',
        'close_session',
      );
    }
    return connection;
  }

  #assertActive(): void {
    if (this.#phase.kind !== 'active') {
      throw grokError(
        'stale_provider_operation',
        'provider session is not active',
        'close_session',
      );
    }
  }

  #revalidate(runtimeGeneration: number): void {
    this.#assertActive();
    if (runtimeGeneration !== this.#runtimeGeneration) {
      throw grokError(
        'stale_provider_operation',
        'Grok session generation changed during the operation',
        'retry_session',
      );
    }
    this.#requireConnection();
  }

  #live() {
    return {
      target: this.#input.target,
      providerDriverKind: GROK_DEFINITION.providerDriverKind,
      providerInstanceId: GROK_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      settledTurnIds: this.#settledTurns,
    };
  }

  #baseEvent(turnId?: string) {
    return {
      eventId: this.#input.ids.nextEventId(),
      target: this.#input.target,
      providerDriverKind: GROK_DEFINITION.providerDriverKind,
      providerInstanceId: GROK_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      createdAt: this.#input.clock.now(),
      ...(turnId === undefined ? {} : { turnId }),
    };
  }
}

function grokError(
  code: ProviderError['code'],
  message: string,
  recoveryAction: ProviderError['recoveryAction'],
): ProviderContractError {
  return createProviderContractError('grok', code, message, recoveryAction);
}

function mapSessionError(error: unknown): ProviderError {
  if (error instanceof ProviderContractError) {
    return error.toProviderError();
  }
  if (error instanceof AcpConnectionError) {
    if (error.rpcCode === XAI_RATE_LIMITED_RPC_CODE) {
      return grokError(
        'unavailable_provider_instance',
        'Grok usage limit reached. Try again later.',
        'refresh',
      ).toProviderError();
    }
    return error.toProviderError();
  }
  return grokError(
    'incompatible_provider_protocol',
    'Grok turn failed.',
    'retry_session',
  ).toProviderError();
}

function readStopReason(result: unknown): string | undefined {
  const parsed = z.object({ stopReason: z.string().optional() }).passthrough().safeParse(result);
  return parsed.success ? parsed.data.stopReason : undefined;
}

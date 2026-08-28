// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import type { AcpNotification, AcpServerRequest } from '../acp/AcpConnection.js';
import { AcpConnectionError } from '../acp/acpConnectionErrors.js';
import {
  admitProviderRuntimeEvent,
  serializedProviderEventBytes,
  type ProviderRuntimeEvent,
} from '../providerEvents.js';
import type { ProviderError } from '../providerErrors.js';
import {
  PRE_ACTIVATION_MAX_BYTES,
  PRE_ACTIVATION_MAX_EVENTS,
  ProviderContractError,
  createProviderContractError,
  type ProviderSession,
  type ProviderSessionCreateInput,
  type ProviderSteerInput,
  type ProviderTurnInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import type { Autonomy } from '../../protocol.js';
import {
  CURSOR_DEFINITION,
  encodeCursorResumeState,
  parseAdvertisedModes,
  resolveCursorAcpBaseModelId,
  resolveCursorSessionModeId,
  type CursorAdvertisedMode,
  type CursorResumeState,
} from './cursorHandshake.js';
import { interpretCursorNotification } from './cursorNotifications.js';
import { CursorPendingRegistry } from './cursorPending.js';
import { handleCursorAcpServerRequest } from './cursorServerRequests.js';
import { toolNameForAcpKind, type CursorToolCallCoalesceState } from './cursorSessionUpdate.js';

export interface CursorAcpClient {
  readonly sessionId: string;
  readonly sessionSetupResult: unknown;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  prompt(blocks: readonly unknown[]): Promise<unknown>;
  cancel(): void;
  close(deadline: ShutdownDeadline): Promise<void>;
}

type SessionPhase =
  | { kind: 'pending'; buffer: ProviderRuntimeEvent[]; bufferBytes: number }
  | { kind: 'active' }
  | { kind: 'closed'; reason: 'overflow' | 'close' };

type ActiveTurn = {
  turnId: string;
  runtimeGeneration: number;
  interrupting: boolean;
  settled: boolean;
};

export class CursorProviderSession implements ProviderSession {
  readonly providerSessionId: string;
  discardedCount = 0;
  nativeCallbacksSettled = false;
  receivedCloseDeadline: ShutdownDeadline | undefined;
  readonly openError = createProviderContractError(
    'cursor',
    'native_session_start_failed',
    'pre-activation buffer overflow',
    'retry_session',
  );

  #phase: SessionPhase = { kind: 'pending', buffer: [], bufferBytes: 0 };
  #connection: CursorAcpClient | undefined;
  #advertisedModes: readonly CursorAdvertisedMode[] = [];
  #activeTurn: ActiveTurn | undefined;
  #storedResumeState: unknown;
  #autonomy: Autonomy;
  #lastTodoFingerprint: string | undefined;
  #acpSessionId: string | undefined;
  readonly #toolCalls = new Map<string, CursorToolCallCoalesceState>();
  readonly #pending = new CursorPendingRegistry();
  readonly #settledTurns = new Set<string>();
  readonly #input: ProviderSessionCreateInput;
  readonly #runtimeGeneration: number;

  constructor(
    input: ProviderSessionCreateInput,
    options: { providerSessionId: string; resumeState?: CursorResumeState },
  ) {
    this.#input = input;
    this.#runtimeGeneration = input.expectedGeneration;
    this.#autonomy = input.configuration.autonomy;
    this.providerSessionId = options.providerSessionId;
    this.#storedResumeState = options.resumeState;
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
    return this.#phase.kind === 'pending' ? this.#phase.buffer.length : 0;
  }

  get pendingInteractionCount(): number {
    return this.#pending.pendingCount;
  }

  get settledInteractionCount(): number {
    return this.#pending.settledCount;
  }

  bindConnection(connection: CursorAcpClient): void {
    this.#connection = connection;
    this.#acpSessionId = connection.sessionId;
    this.#advertisedModes = parseAdvertisedModes(connection.sessionSetupResult);
    const resumeState = encodeCursorResumeState(connection.sessionId);
    this.#storedResumeState = resumeState;
    this.#emit({
      ...this.#baseEvent(),
      type: 'binding.updated',
      binding: { providerSessionId: this.providerSessionId, resumeState },
    });
  }

  onAcpNotification(notification: AcpNotification): void {
    this.#emitInterpreted(notification);
  }

  onAcpServerRequest(request: AcpServerRequest): Promise<unknown> {
    return handleCursorAcpServerRequest(request, {
      runtimeGeneration: this.#runtimeGeneration,
      autonomy: this.#autonomy,
      isLive: () => this.#phase.kind !== 'closed',
      interactionSink: this.#input.interactionSink,
      ids: this.#input.ids,
      target: this.#input.target,
      pending: this.#pending,
      onUpdateTodos: (parsed) =>
        this.#emitInterpreted({
          method: 'cursor/update_todos',
          params: { toolCallId: parsed.toolCallId, todos: parsed.todos, merge: parsed.merge },
        }),
    });
  }

  activate(): void {
    if (this.#phase.kind === 'closed') {
      throw this.#phase.reason === 'overflow'
        ? this.openError
        : cursorError('stale_provider_operation', 'activate is one-shot', 'close_session');
    }
    if (this.#phase.kind === 'active') {
      throw cursorError('stale_provider_operation', 'activate is one-shot', 'close_session');
    }
    const buffered = this.#phase.buffer;
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
    this.#autonomy = input.configuration.autonomy;
    const modelId = resolveCursorAcpBaseModelId(input.configuration.providerSelection.modelId);
    const modeId = resolveCursorSessionModeId(
      input.configuration.interactionMode,
      this.#advertisedModes,
    );
    if (modeId === undefined) {
      throw cursorError(
        'unsupported_capability',
        `Cursor session mode ${input.configuration.interactionMode} is not advertised by the peer.`,
        'refresh',
      );
    }
    await connection.request('session/set_model', { sessionId: connection.sessionId, modelId });
    this.#revalidate(runtimeGeneration);
    await connection.request('session/set_mode', { sessionId: connection.sessionId, modeId });
    this.#revalidate(runtimeGeneration);
    this.#activeTurn = { turnId, runtimeGeneration, interrupting: false, settled: false };
    this.#lastTodoFingerprint = undefined;
    const promptPromise = connection.prompt([{ type: 'text', text: input.prompt.text }]);
    queueMicrotask(() => {
      void promptPromise.then(
        (result) => this.#settleFromPrompt(turnId, runtimeGeneration, result),
        (error: unknown) => this.#settleFromPromptFailure(turnId, runtimeGeneration, error),
      );
    });
  }

  async steer(_input: ProviderSteerInput): Promise<void> {
    throw cursorError('unsupported_capability', 'Cursor steer is not implemented.', 'refresh');
  }

  async interrupt(input: { turnId: string; runtimeGeneration: number }): Promise<void> {
    const runtimeGeneration = this.#runtimeGeneration;
    this.#assertActive();
    if (input.runtimeGeneration !== runtimeGeneration) {
      throw cursorError(
        'stale_provider_operation',
        'interrupt generation does not match the live session',
        'retry_session',
      );
    }
    const active = this.#activeTurn;
    if (!active || active.turnId !== input.turnId || active.settled) {
      throw cursorError(
        'stale_provider_operation',
        'interrupt does not match the in-flight turn',
        'retry_session',
      );
    }
    active.interrupting = true;
    this.#settlePendingInteractions();
    this.#connection?.cancel();
    this.#settleTurn(active.turnId, runtimeGeneration, { status: 'interrupted' });
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.receivedCloseDeadline = deadline;
    if (this.#phase.kind === 'closed') {
      this.#settlePendingInteractions();
      this.nativeCallbacksSettled = true;
      return;
    }
    if (this.#phase.kind === 'pending') {
      this.discardedCount = this.#phase.buffer.length;
    }
    this.#settlePendingInteractions();
    const active = this.#activeTurn;
    if (active && !active.settled && this.#phase.kind === 'active') {
      this.#settleTurn(active.turnId, this.#runtimeGeneration, { status: 'cancelled' });
    }
    this.#phase = { kind: 'closed', reason: 'close' };
    await this.#closeConnection(deadline);
  }

  async failOpenOverflow(deadline: ShutdownDeadline): Promise<void> {
    if (this.#phase.kind === 'pending') {
      this.discardedCount = this.#phase.buffer.length;
    }
    this.#settlePendingInteractions();
    this.#phase = { kind: 'closed', reason: 'overflow' };
    await this.#closeConnection(deadline);
  }

  #emitInterpreted(notification: AcpNotification): void {
    const interpreted = interpretCursorNotification(notification, {
      toolCalls: this.#toolCalls,
      lastTodoFingerprint: this.#lastTodoFingerprint,
    });
    this.#lastTodoFingerprint = interpreted.lastTodoFingerprint;
    for (const transcript of interpreted.transcripts) {
      this.#emit({
        ...this.#baseEvent(this.#activeTurn?.turnId),
        ...(transcript.toolCall
          ? { nativeCorrelation: { itemId: transcript.toolCall.toolCallId } }
          : {}),
        type: 'transcript',
        event: {
          role: 'primary',
          kind: transcript.kind,
          text: transcript.text,
          ...(transcript.toolCall
            ? {
                toolName: toolNameForAcpKind(transcript.toolCall.kind),
                toolUseId: transcript.toolCall.toolCallId,
                ...(transcript.toolCall.status === 'failed' ? { isError: true } : {}),
              }
            : {}),
        },
      });
    }
  }

  #settlePendingInteractions(): void {
    this.#pending.settleAll();
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
    this.#settlePendingInteractions();
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
    this.#settleTurn(turnId, runtimeGeneration, {
      status: 'failed',
      error: mapSessionError(error, 'Cursor turn failed.'),
    });
  }

  #settleTurn(turnId: string, runtimeGeneration: number, settlement: ProviderTurnSettlement): void {
    if (this.#settledTurns.has(turnId)) {
      return;
    }
    if (runtimeGeneration !== this.#runtimeGeneration) {
      return;
    }
    const emitted = this.#emit({
      ...this.#baseEvent(turnId),
      nativeCorrelation: { sessionId: this.#acpSessionId, turnId },
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
      const bytes = serializedProviderEventBytes(event);
      if (
        this.#phase.buffer.length >= PRE_ACTIVATION_MAX_EVENTS ||
        this.#phase.bufferBytes + bytes > PRE_ACTIVATION_MAX_BYTES
      ) {
        this.discardedCount = this.#phase.buffer.length;
        this.#phase = { kind: 'closed', reason: 'overflow' };
        void this.#closeConnection(undefined);
        return false;
      }
      this.#phase.buffer.push(event);
      this.#phase.bufferBytes += bytes;
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
    this.#settlePendingInteractions();
    if (connection) {
      await connection.close(deadline ?? ShutdownDeadline.fromDurationMs(0));
    }
    this.nativeCallbacksSettled = true;
  }

  #requireConnection(): CursorAcpClient {
    const connection = this.#connection;
    if (!connection) {
      throw cursorError(
        'stale_provider_operation',
        'Cursor session has no ACP connection',
        'close_session',
      );
    }
    return connection;
  }

  #assertActive(): void {
    if (this.#phase.kind !== 'active') {
      throw cursorError(
        'stale_provider_operation',
        'provider session is not active',
        'close_session',
      );
    }
  }

  #revalidate(runtimeGeneration: number): void {
    this.#assertActive();
    if (runtimeGeneration !== this.#runtimeGeneration) {
      throw cursorError(
        'stale_provider_operation',
        'Cursor session generation changed during the operation',
        'retry_session',
      );
    }
    this.#requireConnection();
  }

  #live() {
    return {
      target: this.#input.target,
      providerDriverKind: CURSOR_DEFINITION.providerDriverKind,
      providerInstanceId: CURSOR_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      settledTurnIds: this.#settledTurns,
    };
  }

  #baseEvent(turnId?: string) {
    return {
      eventId: this.#input.ids.nextEventId(),
      target: this.#input.target,
      providerDriverKind: CURSOR_DEFINITION.providerDriverKind,
      providerInstanceId: CURSOR_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      createdAt: this.#input.clock.now(),
      ...(turnId === undefined ? {} : { turnId }),
    };
  }
}

function cursorError(
  code: ProviderError['code'],
  message: string,
  recoveryAction: ProviderError['recoveryAction'],
): ProviderContractError {
  return createProviderContractError('cursor', code, message, recoveryAction);
}

function mapSessionError(error: unknown, fallback: string): ProviderError {
  if (error instanceof ProviderContractError) {
    return error.toProviderError();
  }
  if (error instanceof AcpConnectionError) {
    return error.toProviderError();
  }
  return cursorError('incompatible_provider_protocol', fallback, 'retry_session').toProviderError();
}

function readStopReason(result: unknown): string | undefined {
  const parsed = z.object({ stopReason: z.string().optional() }).passthrough().safeParse(result);
  return parsed.success ? parsed.data.stopReason : undefined;
}

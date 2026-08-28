import { DroidInteractionMode, type DroidStreamEvent } from '@factory/droid-sdk';

import { AcpPreActivationBuffer } from '../acp/acpPreActivation.js';
import type { ProviderError } from '../providerErrors.js';
import { admitProviderRuntimeEvent, type ProviderRuntimeEvent } from '../providerEvents.js';
import {
  droidReasoningEffortFromSelection,
  type SessionConfiguration,
} from '../providerIdentity.js';
import {
  ProviderContractError,
  createProviderContractError,
  type ProviderSession,
  type ProviderSessionCreateInput,
  type ProviderSteerInput,
  type ProviderTurnInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import type { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  extractCompactionNotification,
  normalizeNotification,
  normalizeStreamEvent,
  providerEventsFromNormalized,
} from './DroidEventAdapter.js';
import {
  DROID_DEFINITION,
  encodeDroidResumeState,
  factoryReasoningEffort,
  mapAutonomy,
  type DroidResumeState,
} from './DroidModeMapping.js';
import {
  createDroidSessionExtension,
  type DroidSessionExtension,
  type FactorySession,
} from './DroidFactorySession.js';

export type { DroidSessionExtension, FactorySession };
export { readContextBreakdown } from './DroidFactorySession.js';

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

export class DroidProviderSession implements ProviderSession {
  readonly providerSessionId: string;
  readonly droid: DroidSessionExtension;
  discardedCount = 0;
  nativeCallbacksSettled = false;
  receivedCloseDeadline: ShutdownDeadline | undefined;
  readonly openError = createProviderContractError(
    'droid',
    'native_session_start_failed',
    'pre-activation buffer overflow',
    'retry_session',
  );

  #phase: SessionPhase = { kind: 'pending', buffer: new AcpPreActivationBuffer() };
  #factory: FactorySession | undefined;
  #unsubscribe: (() => void) | undefined;
  #activeTurn: ActiveTurn | undefined;
  #storedResumeState: unknown;
  #pending: Array<{ settle: () => void }> = [];
  readonly #settledTurns = new Set<string>();
  readonly #input: ProviderSessionCreateInput;
  readonly #runtimeGeneration: number;

  constructor(
    input: ProviderSessionCreateInput,
    options: { providerSessionId: string; resumeState?: DroidResumeState },
  ) {
    this.#input = input;
    this.#runtimeGeneration = input.expectedGeneration;
    this.providerSessionId = options.providerSessionId;
    this.#storedResumeState = options.resumeState;
    this.droid = createDroidSessionExtension(
      () => this.#requireFactory(),
      (session, kind) => this.replaceNativeSession(session, kind),
    );
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

  get createInput(): ProviderSessionCreateInput {
    return this.#input;
  }

  get runtimeGeneration(): number {
    return this.#runtimeGeneration;
  }

  bindFactorySession(session: FactorySession): void {
    this.replaceNativeSession(session, 'native_replacement');
  }

  replaceNativeSession(session: FactorySession, kind: 'resume_state' | 'native_replacement'): void {
    this.#unsubscribe?.();
    this.#factory = session;
    const resumeState = encodeDroidResumeState(session.sessionId);
    this.#storedResumeState = resumeState;
    this.#unsubscribe = session.onNotification((notification) => {
      this.#onNativeNotification(notification as Record<string, unknown>);
    });
    this.#emit({
      ...this.#baseEvent(),
      type: 'binding.updated',
      binding:
        kind === 'native_replacement'
          ? { providerSessionId: this.providerSessionId, resumeState }
          : { resumeState },
    });
  }

  activate(): void {
    if (this.#phase.kind === 'closed') {
      throw this.#phase.reason === 'overflow'
        ? this.openError
        : droidError('stale_provider_operation', 'activate is one-shot', 'close_session');
    }
    if (this.#phase.kind === 'active') {
      throw droidError('stale_provider_operation', 'activate is one-shot', 'close_session');
    }
    const buffered = this.#phase.buffer.drain();
    this.#phase = { kind: 'active' };
    for (const event of buffered) this.#deliverIfAdmitted(event);
  }

  async startTurn(input: ProviderTurnInput): Promise<void> {
    const runtimeGeneration = this.#runtimeGeneration;
    const turnId = input.turnId;
    const factory = this.#requireFactory();
    this.#assertActive();
    await this.#applyConfiguration(input.configuration);
    this.#revalidate(runtimeGeneration);
    this.#activeTurn = { turnId, runtimeGeneration, interrupting: false, settled: false };
    const stream = factory.stream(input.prompt.text, { includePartialMessages: true });
    queueMicrotask(() => {
      void this.#consumeStream(turnId, runtimeGeneration, stream);
    });
  }

  async steer(_input: ProviderSteerInput): Promise<void> {
    throw droidError('unsupported_capability', 'provider droid does not support steer', 'refresh');
  }

  async interrupt(input: { turnId: string; runtimeGeneration: number }): Promise<void> {
    const runtimeGeneration = this.#runtimeGeneration;
    this.#assertActive();
    if (input.runtimeGeneration !== runtimeGeneration) {
      throw droidError(
        'stale_provider_operation',
        'interrupt generation does not match the live session',
        'retry_session',
      );
    }
    const active = this.#activeTurn;
    if (!active || active.turnId !== input.turnId || active.settled) {
      throw droidError(
        'stale_provider_operation',
        'interrupt does not match the in-flight turn',
        'retry_session',
      );
    }
    active.interrupting = true;
    this.#settlePendingInteractions();
    await this.#factory?.interrupt();
    this.#settleTurn(active.turnId, runtimeGeneration, { status: 'interrupted' });
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.receivedCloseDeadline = deadline;
    if (this.#phase.kind === 'closed') {
      this.#settlePendingInteractions();
      this.nativeCallbacksSettled = true;
      return;
    }
    if (this.#phase.kind === 'pending') this.discardedCount = this.#phase.buffer.size;
    this.#settlePendingInteractions();
    const active = this.#activeTurn;
    if (active && !active.settled && this.#phase.kind === 'active') {
      this.#settleTurn(active.turnId, this.#runtimeGeneration, { status: 'cancelled' });
    }
    this.#phase = { kind: 'closed', reason: 'close' };
    await this.#closeFactory();
  }

  runNativeCallback<T>(work: () => Promise<T>): Promise<T> {
    let settle = (): void => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      settle = () => {
        reject(
          droidError('interaction_cancelled', 'Droid interaction cancelled.', 'retry_session'),
        );
      };
    });
    const waiter = { settle };
    this.#pending.push(waiter);
    return Promise.race([work(), cancelled]).finally(() => {
      this.#pending = this.#pending.filter((entry) => entry !== waiter);
    });
  }

  async #consumeStream(
    turnId: string,
    runtimeGeneration: number,
    stream: AsyncGenerator<DroidStreamEvent, void, undefined>,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        if (!this.#isLiveTurn(turnId, runtimeGeneration)) return;
        this.#emitNormalized(normalizeStreamEvent(...this.#normalizeArgs(), event), turnId);
      }
      const active = this.#activeTurn;
      if (!active || active.turnId !== turnId || active.settled) return;
      if (runtimeGeneration !== this.#runtimeGeneration || this.#phase.kind === 'closed') return;
      this.#settleTurn(
        turnId,
        runtimeGeneration,
        active.interrupting ? { status: 'interrupted' } : { status: 'completed' },
      );
    } catch (error) {
      this.#settlePendingInteractions();
      const active = this.#activeTurn;
      if (!active || active.turnId !== turnId || active.settled) return;
      if (runtimeGeneration !== this.#runtimeGeneration || this.#phase.kind === 'closed') return;
      this.#settleTurn(
        turnId,
        runtimeGeneration,
        active.interrupting
          ? { status: 'interrupted' }
          : { status: 'failed', error: mapSessionError(error) },
      );
    }
  }

  #onNativeNotification(notification: Record<string, unknown>): void {
    const compaction = extractCompactionNotification(notification);
    if (compaction) {
      this.#emit({
        ...this.#baseEvent(this.#activeTurn?.turnId),
        type: 'session.effect',
        effect: {
          kind: 'compaction',
          compactType: 'auto',
          removedCount: compaction.removedCount,
        },
      });
    }
    for (const normalized of normalizeNotification(...this.#normalizeArgs(), notification)) {
      this.#emitNormalized(normalized, this.#activeTurn?.turnId);
    }
  }

  #emitNormalized(normalized: ReturnType<typeof normalizeStreamEvent>, turnId?: string): void {
    if (!normalized || normalized.done) return;
    for (const event of providerEventsFromNormalized(normalized, this.#baseEvent(turnId))) {
      this.#emit(event);
    }
  }

  #normalizeArgs(): [string, string, 'primary'] {
    const appSessionId =
      this.#input.target.kind === 'session'
        ? this.#input.target.appSessionId
        : this.#input.target.parentAppSessionId;
    return [appSessionId, this.#factory?.sessionId ?? this.providerSessionId, 'primary'];
  }

  async #applyConfiguration(configuration: SessionConfiguration): Promise<void> {
    const factory = this.#requireFactory();
    const modelId = configuration.providerSelection.modelId;
    const reasoningEffort = droidReasoningEffortFromSelection(configuration.providerSelection);
    const native: Record<string, unknown> = {
      modelId,
      specModeModelId: modelId,
      autonomyLevel: mapAutonomy(configuration.autonomy),
    };
    if (reasoningEffort !== undefined) {
      native.reasoningEffort = factoryReasoningEffort(reasoningEffort);
      native.specModeReasoningEffort = factoryReasoningEffort(reasoningEffort);
    }
    if (configuration.interactionMode === 'spec') await factory.enterSpecMode();
    else
      native.interactionMode =
        configuration.interactionMode === 'agi'
          ? DroidInteractionMode.AGI
          : DroidInteractionMode.Auto;
    await factory.updateSettings(native);
  }

  #settlePendingInteractions(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const waiter of pending) waiter.settle();
    this.nativeCallbacksSettled = true;
  }

  #settleTurn(turnId: string, runtimeGeneration: number, settlement: ProviderTurnSettlement): void {
    if (this.#settledTurns.has(turnId) || runtimeGeneration !== this.#runtimeGeneration) return;
    const emitted = this.#emit({
      ...this.#baseEvent(turnId),
      nativeCorrelation: { sessionId: this.#factory?.sessionId, turnId },
      type: 'turn.settled',
      settlement,
    });
    if (emitted || this.#phase.kind === 'closed') {
      this.#settledTurns.add(turnId);
      if (this.#activeTurn?.turnId === turnId) this.#activeTurn.settled = true;
    }
  }

  #emit(event: ProviderRuntimeEvent): boolean {
    if (this.#phase.kind === 'closed') return false;
    if (!admitProviderRuntimeEvent(event, this.#live()).ok) return false;
    if (this.#phase.kind === 'pending') {
      if (!this.#phase.buffer.tryPush(event)) {
        this.discardedCount = this.#phase.buffer.size;
        this.#settlePendingInteractions();
        this.#phase = { kind: 'closed', reason: 'overflow' };
        void this.#closeFactory();
        return false;
      }
      return true;
    }
    this.#deliver(event);
    return true;
  }

  #deliverIfAdmitted(event: ProviderRuntimeEvent): void {
    if (admitProviderRuntimeEvent(event, this.#live()).ok) this.#deliver(event);
  }

  #deliver(event: ProviderRuntimeEvent): void {
    this.#input.eventSink(event);
    if (event.type === 'turn.settled' && event.turnId !== undefined) {
      this.#settledTurns.add(event.turnId);
    }
  }

  async #closeFactory(): Promise<void> {
    this.#settlePendingInteractions();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const factory = this.#factory;
    this.#factory = undefined;
    if (factory) await factory.close();
    this.nativeCallbacksSettled = true;
  }

  #requireFactory(): FactorySession {
    const factory = this.#factory;
    if (!factory) {
      throw droidError(
        'stale_provider_operation',
        'Droid session has no Factory session',
        'close_session',
      );
    }
    return factory;
  }

  #assertActive(): void {
    if (this.#phase.kind !== 'active') {
      throw droidError(
        'stale_provider_operation',
        'provider session is not active',
        'close_session',
      );
    }
  }

  #revalidate(runtimeGeneration: number): void {
    this.#assertActive();
    if (runtimeGeneration !== this.#runtimeGeneration) {
      throw droidError(
        'stale_provider_operation',
        'Droid session generation changed during the operation',
        'retry_session',
      );
    }
    this.#requireFactory();
  }

  #isLiveTurn(turnId: string, runtimeGeneration: number): boolean {
    const active = this.#activeTurn;
    return (
      this.#phase.kind !== 'closed' &&
      runtimeGeneration === this.#runtimeGeneration &&
      active?.turnId === turnId &&
      !active.settled
    );
  }

  #live() {
    return {
      target: this.#input.target,
      providerDriverKind: DROID_DEFINITION.providerDriverKind,
      providerInstanceId: DROID_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      settledTurnIds: this.#settledTurns,
    };
  }

  #baseEvent(turnId?: string) {
    return {
      eventId: this.#input.ids.nextEventId(),
      target: this.#input.target,
      providerDriverKind: DROID_DEFINITION.providerDriverKind,
      providerInstanceId: DROID_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      createdAt: this.#input.clock.now(),
      ...(turnId === undefined ? {} : { turnId }),
    };
  }
}

function droidError(
  code: ProviderError['code'],
  message: string,
  recoveryAction: ProviderError['recoveryAction'],
): ProviderContractError {
  return createProviderContractError('droid', code, message, recoveryAction);
}

function mapSessionError(error: unknown): ProviderError {
  if (error instanceof ProviderContractError) return error.toProviderError();
  return droidError(
    'incompatible_provider_protocol',
    'Droid turn failed.',
    'retry_session',
  ).toProviderError();
}

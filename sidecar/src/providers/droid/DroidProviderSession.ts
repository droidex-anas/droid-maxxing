import { DroidInteractionMode, type DroidStreamEvent } from '@factory/droid-sdk';

import { AcpPreActivationBuffer } from '../acp/acpPreActivation.js';
import { admitProviderRuntimeEvent, type ProviderRuntimeEvent } from '../providerEvents.js';
import {
  configurationsEqual,
  droidReasoningEffortFromSelection,
  type SessionConfiguration,
} from '../providerIdentity.js';
import {
  createProviderContractError,
  type ProviderSession,
  type ProviderSessionCreateInput,
  type ProviderSteerInput,
  type ProviderTurnInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import { droidError, mapSessionError } from './droidSessionErrors.js';
import type { ShutdownDeadline } from '../shutdownDeadline.js';
import { hotPathMetrics } from '../../telemetry/hotPathMetrics.js';
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
  #allocatedProviderSessionId: string;
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
  #appliedConfiguration: SessionConfiguration;
  readonly #settledTurns = new Set<string>();
  readonly #input: ProviderSessionCreateInput;
  readonly #runtimeGeneration: number;

  constructor(
    input: ProviderSessionCreateInput,
    options: { providerSessionId: string; resumeState?: DroidResumeState },
  ) {
    this.#input = input;
    this.#runtimeGeneration = input.expectedGeneration;
    this.#appliedConfiguration = input.configuration;
    this.#allocatedProviderSessionId = options.providerSessionId;
    this.#storedResumeState = options.resumeState;
    this.droid = createDroidSessionExtension(
      () => this.#requireFactory(),
      (session, kind) => this.replaceNativeSession(session, kind),
    );
  }

  get providerSessionId(): string {
    return this.#factory?.sessionId ?? this.#allocatedProviderSessionId;
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

  get nativeSession(): FactorySession | undefined {
    return this.#factory;
  }

  attachFactory(session: FactorySession): void {
    this.#factory = session;
    const resumeState = encodeDroidResumeState(session.sessionId);
    this.#storedResumeState = resumeState;
    this.#emit({
      ...this.#baseEvent(),
      type: 'binding.updated',
      binding: { providerSessionId: this.providerSessionId, resumeState },
    });
  }

  subscribeNativeNotifications(): void {
    const factory = this.#factory;
    if (!factory) return;
    this.#unsubscribe?.();
    this.#unsubscribe = factory.onNotification((notification) => {
      this.#onNativeNotification(notification as Record<string, unknown>);
    });
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
    void this.#consumeStream(turnId, runtimeGeneration, stream);
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
    await this.#closeFactory(deadline);
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
        if (this.#phase.kind === 'closed' || runtimeGeneration !== this.#runtimeGeneration) return;
        const normalizeStartedAt = performance.now();
        const normalized = normalizeStreamEvent(...this.#normalizeArgs(), event);
        hotPathMetrics.recordNormalize(performance.now() - normalizeStartedAt);
        if (normalized?.done) {
          if (this.#isLiveTurn(turnId, runtimeGeneration)) {
            this.#settleTurn(
              turnId,
              runtimeGeneration,
              this.#activeTurn?.interrupting ? { status: 'interrupted' } : { status: 'completed' },
            );
          }
          continue;
        }
        const emitTurnId = this.#activeTurn?.settled ? undefined : turnId;
        this.#emitNormalized(normalized, emitTurnId);
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
    const base = this.#baseEvent(turnId);
    for (const event of providerEventsFromNormalized(normalized, base)) {
      this.#emit({ ...event, eventId: this.#input.ids.nextEventId() });
    }
  }

  #normalizeArgs(): [string, string, 'primary'] {
    const appSessionId = this.#appSessionId();
    return [appSessionId, this.#factory?.sessionId ?? this.providerSessionId, 'primary'];
  }

  async #applyConfiguration(configuration: SessionConfiguration): Promise<void> {
    if (configurationsEqual(this.#appliedConfiguration, configuration)) return;
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
    try {
      if (configuration.interactionMode === 'spec') await factory.enterSpecMode();
      else
        native.interactionMode =
          configuration.interactionMode === 'agi'
            ? DroidInteractionMode.AGI
            : DroidInteractionMode.Auto;
      await factory.updateSettings(native);
      this.#appliedConfiguration = configuration;
    } catch (error) {
      throw new Error(
        `Could not apply session configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  async #closeFactory(deadline?: ShutdownDeadline): Promise<void> {
    this.#settlePendingInteractions();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const factory = this.#factory;
    this.#factory = undefined;
    if (factory) await factory.close(deadline);
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
      target: this.#eventTarget(),
      providerDriverKind: DROID_DEFINITION.providerDriverKind,
      providerInstanceId: DROID_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      settledTurnIds: this.#settledTurns,
    };
  }

  #appSessionId(): string {
    if (this.#input.target.kind === 'session') {
      const requested = this.#input.target.appSessionId;
      if (!requested.startsWith('pending:')) return requested;
    }
    if (this.#factory) return this.#factory.sessionId;
    return this.#input.target.kind === 'session'
      ? this.#input.target.appSessionId
      : this.#input.target.parentAppSessionId;
  }

  #eventTarget(): ProviderSessionCreateInput['target'] {
    if (this.#input.target.kind === 'child') return this.#input.target;
    return { kind: 'session', appSessionId: this.#appSessionId() };
  }

  #baseEvent(turnId?: string) {
    return {
      eventId: this.#input.ids.nextEventId(),
      target: this.#eventTarget(),
      providerDriverKind: DROID_DEFINITION.providerDriverKind,
      providerInstanceId: DROID_DEFINITION.providerInstanceId,
      runtimeGeneration: this.#runtimeGeneration,
      createdAt: this.#input.clock.now(),
      ...(turnId === undefined ? {} : { turnId }),
    };
  }
}

import {
  admitProviderRuntimeEvent,
  serializedProviderEventBytes,
  type ProviderRuntimeEvent,
} from '../providerEvents.js';
import type { ProviderDriverKind, ProviderInstanceId, SessionTarget } from '../providerIdentity.js';
import {
  PRE_ACTIVATION_MAX_BYTES,
  PRE_ACTIVATION_MAX_EVENTS,
  createProviderContractError,
  type ProviderPrompt,
  type ProviderSession,
  type ProviderSessionCreateInput,
  type ProviderSteerInput,
  type ProviderTurnInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import type { ShutdownDeadline } from '../shutdownDeadline.js';
import type { FakeAdapterHost, FakeProviderCall } from './FakeProviderAdapter.js';

type SessionPhase =
  | { kind: 'pending'; buffer: ProviderRuntimeEvent[]; bufferBytes: number }
  | { kind: 'active' }
  | { kind: 'closed'; reason: 'overflow' | 'close' };

export class FakeProviderSession implements ProviderSession {
  readonly providerSessionId: string;
  readonly initialResumeState: unknown;
  readonly nativeSessionId: string;
  readonly nativeTurnIds = new Map<string, string>();
  readonly calls: FakeProviderCall[] = [];
  readonly acceptedTurns: string[] = [];
  readonly settlements: Array<{ turnId: string; settlement: ProviderTurnSettlement }> = [];
  readonly rejectedEvents: ProviderRuntimeEvent[] = [];
  receivedCloseDeadline: ShutdownDeadline | undefined;
  nativeCallbacksSettled = false;
  cleanedUp = false;
  discardedCount = 0;
  openError = createProviderContractError(
    'droid',
    'native_session_start_failed',
    'pre-activation buffer overflow',
    'retry_session',
  );
  #phase: SessionPhase = { kind: 'pending', buffer: [], bufferBytes: 0 };
  readonly #adapter: FakeAdapterHost;
  readonly #input: ProviderSessionCreateInput;
  readonly #nativeCallbacks: Array<() => void> = [];
  readonly #settledTurns = new Set<string>();

  constructor(adapter: FakeAdapterHost, input: ProviderSessionCreateInput, resumeState: unknown) {
    this.#adapter = adapter;
    this.#input = input;
    this.providerSessionId = input.ids.nextProviderSessionId();
    this.initialResumeState = resumeState;
    this.nativeSessionId = `native-${this.providerSessionId}`;
    this.openError = createProviderContractError(
      adapter.definition.providerInstanceId,
      'native_session_start_failed',
      'pre-activation buffer overflow',
      'retry_session',
    );
  }

  get target(): SessionTarget {
    return this.#input.target;
  }

  get runtimeGeneration(): number {
    return this.#input.expectedGeneration;
  }

  get resumeState(): unknown {
    return this.initialResumeState;
  }

  get failedOpen(): boolean {
    return this.#phase.kind === 'closed' && this.#phase.reason === 'overflow';
  }

  get isClosed(): boolean {
    return this.#phase.kind === 'closed';
  }

  get bufferedEventCount(): number {
    return this.#phase.kind === 'pending' ? this.#phase.buffer.length : 0;
  }

  get bufferedBytes(): number {
    return this.#phase.kind === 'pending' ? this.#phase.bufferBytes : 0;
  }

  get laterEventsAccepted(): boolean {
    return this.#phase.kind === 'pending' || this.#phase.kind === 'active';
  }

  activate(): void {
    this.calls.push({ op: 'activate' });
    this.#adapter.calls.push({ op: 'activate' });
    if (this.#phase.kind === 'closed') {
      throw this.#phase.reason === 'overflow'
        ? this.openError
        : createProviderContractError(
            this.#adapter.definition.providerInstanceId,
            'stale_provider_operation',
            'activate is one-shot',
            'close_session',
          );
    }
    if (this.#phase.kind === 'active') {
      throw createProviderContractError(
        this.#adapter.definition.providerInstanceId,
        'stale_provider_operation',
        'activate is one-shot',
        'close_session',
      );
    }
    const buffered = this.#phase.buffer;
    this.#phase = { kind: 'active' };
    for (const event of buffered) {
      this.#deliverIfAdmitted(event);
    }
  }

  async startTurn(input: ProviderTurnInput): Promise<void> {
    this.calls.push({ op: 'startTurn', turnId: input.turnId });
    this.#adapter.calls.push({ op: 'startTurn', turnId: input.turnId });
    this.#assertLive();
    await this.#adapter.gates.run('startTurn');
    this.acceptedTurns.push(input.turnId);
    this.nativeTurnIds.set(input.turnId, `native-turn-${input.turnId}`);
  }

  async steer(input: ProviderSteerInput): Promise<void> {
    this.calls.push({ op: 'steer', turnId: input.turnId });
    this.#adapter.calls.push({ op: 'steer', turnId: input.turnId });
    this.#assertLive();
    await this.#adapter.gates.run('steer');
  }

  async interrupt(input: { turnId: string; runtimeGeneration: number }): Promise<void> {
    this.calls.push({
      op: 'interrupt',
      turnId: input.turnId,
      runtimeGeneration: input.runtimeGeneration,
    });
    this.#adapter.calls.push({
      op: 'interrupt',
      turnId: input.turnId,
      runtimeGeneration: input.runtimeGeneration,
    });
    this.#assertLive();
    if (input.runtimeGeneration !== this.runtimeGeneration) {
      throw createProviderContractError(
        this.#adapter.definition.providerInstanceId,
        'stale_provider_operation',
        'interrupt generation does not match the live session',
        'retry_session',
      );
    }
    await this.#adapter.gates.run('interrupt');
  }

  abandon(): void {
    if (this.#phase.kind === 'pending') {
      this.discardedCount = this.#phase.buffer.length;
      this.#settleNativeCallbacks();
    }
    if (this.#phase.kind !== 'closed') {
      this.#phase = { kind: 'closed', reason: 'close' };
    }
    this.cleanedUp = true;
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.calls.push({ op: 'session.close', deadline });
    this.#adapter.calls.push({ op: 'session.close', deadline });
    this.receivedCloseDeadline = deadline;
    await this.#adapter.gates.run('session.close');
    if (this.#phase.kind === 'closed') {
      this.cleanedUp = true;
      return;
    }
    if (this.#phase.kind === 'pending') {
      this.discardedCount = this.#phase.buffer.length;
      this.#settleNativeCallbacks();
    }
    this.#phase = { kind: 'closed', reason: 'close' };
    this.cleanedUp = true;
  }

  emitPreActivationWarnings(count: number): void {
    for (let index = 0; index < count; index += 1) {
      if (!this.tryEmit(this.buildWarning(`preactivation-${index + 1}`))) {
        return;
      }
    }
  }

  buildWarning(
    message: string,
    overrides: {
      eventId?: string;
      target?: SessionTarget;
      providerDriverKind?: ProviderDriverKind;
      providerInstanceId?: ProviderInstanceId;
      runtimeGeneration?: number;
      turnId?: string;
    } = {},
  ): ProviderRuntimeEvent {
    return {
      eventId: overrides.eventId ?? this.#input.ids.nextEventId(),
      target: overrides.target ?? this.#input.target,
      providerDriverKind:
        overrides.providerDriverKind ?? this.#adapter.definition.providerDriverKind,
      providerInstanceId:
        overrides.providerInstanceId ?? this.#adapter.definition.providerInstanceId,
      runtimeGeneration: overrides.runtimeGeneration ?? this.#input.expectedGeneration,
      createdAt: this.#input.clock.now(),
      ...(overrides.turnId === undefined ? {} : { turnId: overrides.turnId }),
      type: 'warning',
      message,
    };
  }

  tryEmit(event: ProviderRuntimeEvent): boolean {
    if (this.#phase.kind === 'closed') {
      this.rejectedEvents.push(event);
      return false;
    }
    const admitted = admitProviderRuntimeEvent(event, this.#live());
    if (!admitted.ok) {
      this.rejectedEvents.push(event);
      return false;
    }
    if (this.#phase.kind === 'pending') {
      const bytes = serializedProviderEventBytes(event);
      if (
        this.#phase.buffer.length >= PRE_ACTIVATION_MAX_EVENTS ||
        this.#phase.bufferBytes + bytes > PRE_ACTIVATION_MAX_BYTES
      ) {
        this.discardedCount = this.#phase.buffer.length;
        this.#settleNativeCallbacks();
        this.#phase = { kind: 'closed', reason: 'overflow' };
        this.cleanedUp = true;
        this.rejectedEvents.push(event);
        return false;
      }
      this.#phase.buffer.push(event);
      this.#phase.bufferBytes += bytes;
      return true;
    }
    this.#deliver(event);
    return true;
  }

  emitTurnSettled(turnId: string, settlement: ProviderTurnSettlement): boolean {
    return this.tryEmit({
      eventId: this.#input.ids.nextEventId(),
      target: this.#input.target,
      providerDriverKind: this.#adapter.definition.providerDriverKind,
      providerInstanceId: this.#adapter.definition.providerInstanceId,
      runtimeGeneration: this.#input.expectedGeneration,
      createdAt: this.#input.clock.now(),
      turnId,
      nativeCorrelation: {
        sessionId: this.nativeSessionId,
        turnId: this.nativeTurnIds.get(turnId),
      },
      type: 'turn.settled',
      settlement,
    });
  }

  registerNativeCallback(): Promise<void> {
    return new Promise((resolve) => {
      this.#nativeCallbacks.push(resolve);
    });
  }

  prompt(text: string): ProviderPrompt {
    return { text, skills: [], files: [], browserRefs: [] };
  }

  #live() {
    return {
      target: this.#input.target,
      providerDriverKind: this.#adapter.definition.providerDriverKind,
      providerInstanceId: this.#adapter.definition.providerInstanceId,
      runtimeGeneration: this.#input.expectedGeneration,
      settledTurnIds: this.#settledTurns,
    };
  }

  #deliverIfAdmitted(event: ProviderRuntimeEvent): void {
    const admitted = admitProviderRuntimeEvent(event, this.#live());
    if (!admitted.ok) {
      this.rejectedEvents.push(event);
      return;
    }
    this.#deliver(event);
  }

  #deliver(event: ProviderRuntimeEvent): void {
    this.#input.eventSink(event);
    if (event.type === 'turn.settled' && event.turnId !== undefined) {
      this.#settledTurns.add(event.turnId);
      this.settlements.push({ turnId: event.turnId, settlement: event.settlement });
    }
  }

  #settleNativeCallbacks(): void {
    for (const settle of this.#nativeCallbacks) {
      settle();
    }
    this.#nativeCallbacks.length = 0;
    this.nativeCallbacksSettled = true;
  }

  #assertLive(): void {
    if (this.#phase.kind !== 'active') {
      throw createProviderContractError(
        this.#adapter.definition.providerInstanceId,
        'stale_provider_operation',
        'provider session is not active',
        'close_session',
      );
    }
  }
}

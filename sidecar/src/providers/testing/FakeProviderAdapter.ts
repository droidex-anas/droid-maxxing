import {
  assertCreateInputMatchesAdapter,
  assertDefinitionConsistency,
  createProviderContractError,
  defineProviderCapabilities,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderClock,
  type ProviderDefinition,
  type ProviderIdSource,
  type ProviderInteractionSink,
  type ProviderSessionCreateInput,
  type ProviderSessionResumeInput,
  type ProviderSnapshot,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import { FakeProviderSession } from './FakeProviderSession.js';

export type FakeAwaitName =
  | 'probe'
  | 'create'
  | 'resume'
  | 'startTurn'
  | 'steer'
  | 'interrupt'
  | 'session.close'
  | 'adapter.close';

export type FakeProviderCall =
  | { readonly op: 'probe' }
  | { readonly op: 'create' }
  | { readonly op: 'resume' }
  | { readonly op: 'adapter.close'; readonly deadline: ShutdownDeadline }
  | { readonly op: 'activate' }
  | { readonly op: 'startTurn'; readonly turnId: string }
  | { readonly op: 'steer'; readonly turnId: string }
  | { readonly op: 'interrupt'; readonly turnId: string; readonly runtimeGeneration: number }
  | { readonly op: 'session.close'; readonly deadline: ShutdownDeadline };

export class FakeAwaitGates {
  readonly #blocked = new Set<FakeAwaitName>();
  readonly #failures = new Map<FakeAwaitName, unknown>();
  readonly #waiters = new Map<
    FakeAwaitName,
    Array<(result: { ok: true } | { ok: false; error: unknown }) => void>
  >();
  readonly #entered = new Map<FakeAwaitName, { promise: Promise<void>; resolve: () => void }>();

  block(name: FakeAwaitName): void {
    this.#blocked.add(name);
  }

  fail(name: FakeAwaitName, error: unknown): void {
    this.#failures.set(name, error);
    const waiters = this.#waiters.get(name) ?? [];
    this.#waiters.delete(name);
    for (const waiter of waiters) {
      waiter({ ok: false, error });
    }
  }

  release(name: FakeAwaitName): void {
    this.#blocked.delete(name);
    const waiters = this.#waiters.get(name) ?? [];
    this.#waiters.delete(name);
    for (const waiter of waiters) {
      waiter({ ok: true });
    }
  }

  waitUntilBlocked(name: FakeAwaitName): Promise<void> {
    const existing = this.#entered.get(name);
    if (existing) {
      return existing.promise;
    }
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((next) => {
      resolve = () => {
        next();
      };
    });
    this.#entered.set(name, { promise, resolve });
    return promise;
  }

  async run(name: FakeAwaitName): Promise<void> {
    const failure = this.#failures.get(name);
    if (failure !== undefined) {
      this.#failures.delete(name);
      throw failure;
    }
    if (!this.#blocked.has(name)) {
      return;
    }
    const entered = this.#entered.get(name);
    if (entered) {
      entered.resolve();
    } else {
      this.#entered.set(name, { promise: Promise.resolve(), resolve: () => undefined });
    }
    await new Promise<void>((resolve, reject) => {
      const waiters = this.#waiters.get(name) ?? [];
      waiters.push((result) => {
        if (result.ok) {
          resolve();
          return;
        }
        reject(result.error);
      });
      this.#waiters.set(name, waiters);
    });
    this.#entered.delete(name);
    const after = this.#failures.get(name);
    if (after !== undefined) {
      this.#failures.delete(name);
      throw after;
    }
  }
}

export interface FakeAdapterHost {
  readonly definition: ProviderDefinition;
  readonly calls: FakeProviderCall[];
  readonly gates: FakeAwaitGates;
}

export function createTestIdSource(prefix = 'fake'): ProviderIdSource {
  let events = 0;
  let sessions = 0;
  return {
    nextEventId: () => `${prefix}-evt-${++events}`,
    nextProviderSessionId: () => `${prefix}-prov-${++sessions}`,
  };
}

export function createTestClock(start = 1_000): ProviderClock {
  return { now: () => start };
}

export function cancelingInteractionSink(): ProviderInteractionSink {
  return {
    requestApproval: async () => ({ decision: 'cancel' }),
    requestQuestion: async () => ({ status: 'cancelled' }),
    requestPlanReview: async () => ({ decision: 'cancel' }),
  };
}

export function completeFakeCapabilities(
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities {
  return defineProviderCapabilities({
    modes: ['auto', 'spec', 'agi'],
    autonomyLevels: ['off', 'low', 'medium', 'high'],
    modelChange: 'before_turn',
    resume: true,
    steer: true,
    interrupt: true,
    approvals: true,
    questions: true,
    planReview: true,
    context: true,
    compaction: true,
    skills: true,
    slashCommands: true,
    mcpUse: true,
    mcpManagement: true,
    rewind: true,
    fork: true,
    observationalTasks: true,
    addressableChildren: true,
    missionControl: true,
    browser: true,
    usageReporting: true,
    reasoningStream: true,
    ...overrides,
  });
}

export class FakeProviderAdapter implements ProviderAdapter, FakeAdapterHost {
  readonly definition: ProviderDefinition;
  readonly calls: FakeProviderCall[] = [];
  readonly sessions: FakeProviderSession[] = [];
  readonly gates = new FakeAwaitGates();
  preActivationEventCount = 1;
  snapshot: ProviderSnapshot;
  receivedCloseDeadline: ShutdownDeadline | undefined;

  constructor(definition: ProviderDefinition = defaultDefinition()) {
    assertDefinitionConsistency(definition);
    this.definition = definition;
    this.snapshot = {
      definition,
      revision: 1,
      readiness: 'ready',
      models: [
        {
          id: 'model-a',
          displayName: 'Model A',
          isDefault: true,
          supportedReasoningEfforts: ['low', 'medium', 'high'],
          serviceTiers: [],
        },
      ],
      capabilities: completeFakeCapabilities(),
    };
  }

  async probe(signal: AbortSignal): Promise<ProviderSnapshot> {
    this.calls.push({ op: 'probe' });
    if (signal.aborted) {
      throw createProviderContractError(
        this.definition.providerInstanceId,
        'stale_provider_operation',
        'probe aborted',
        'refresh',
      );
    }
    await this.gates.run('probe');
    return this.snapshot;
  }

  async create(input: ProviderSessionCreateInput): Promise<FakeProviderSession> {
    this.calls.push({ op: 'create' });
    assertCreateInputMatchesAdapter(this.definition, input);
    const session = this.#openSession(input, { created: true });
    session.emitPreActivationWarnings(this.preActivationEventCount);
    if (session.failedOpen) {
      throw session.openError;
    }
    try {
      await this.gates.run('create');
    } catch (error) {
      session.abandon();
      throw error;
    }
    if (session.failedOpen) {
      throw session.openError;
    }
    return session;
  }

  async resume(input: ProviderSessionResumeInput): Promise<FakeProviderSession> {
    this.calls.push({ op: 'resume' });
    assertCreateInputMatchesAdapter(this.definition, input);
    const session = this.#openSession(input, input.resumeState);
    session.emitPreActivationWarnings(this.preActivationEventCount);
    if (session.failedOpen) {
      throw session.openError;
    }
    try {
      await this.gates.run('resume');
    } catch (error) {
      session.abandon();
      throw error;
    }
    if (session.failedOpen) {
      throw session.openError;
    }
    return session;
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.calls.push({ op: 'adapter.close', deadline });
    this.receivedCloseDeadline = deadline;
    await this.gates.run('adapter.close');
    for (const session of [...this.sessions].reverse()) {
      await session.close(deadline);
    }
  }

  #openSession(input: ProviderSessionCreateInput, resumeState: unknown): FakeProviderSession {
    const session = new FakeProviderSession(this, input, resumeState);
    this.sessions.push(session);
    return session;
  }
}

function defaultDefinition(): ProviderDefinition {
  return {
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    displayName: 'Fake Droid',
  };
}

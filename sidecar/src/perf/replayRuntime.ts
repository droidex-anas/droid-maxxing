// Provider-side replay runtime for the perf harness: implements the same
// FactoryRuntime/FactorySession surface the real Droid CLI transport does,
// but yields scripted DroidStreamEvents on the scenario's deterministic
// schedule. Every yield is reported to the runner so provider-to-wire latency
// can be measured on events that traverse the pipeline unmerged.

import {
  ContextStatsAccuracy,
  InitializeSessionResultSchema,
  ReasoningEffort as SdkReasoningEffort,
  type DroidStreamEvent,
  type MessageOptions,
} from '@factory/droid-sdk';
import type {
  CreateRuntimeSessionOptions,
  RuntimeHandlers,
} from '../providers/droid/DroidModeMapping.js';
import type { FactoryRuntime, RuntimeStatus } from '../providers/droid/DroidProviderAdapter.js';
import type { FactorySession } from '../providers/droid/DroidProviderSession.js';
import type { ReplayTurnPlan } from './scenario.js';
import { successfulResultEvent } from '../testing/fakeFactoryRuntime.js';

export interface ReplayYieldReport {
  sessionIndex: number;
  turn: number;
  marker: string | null;
  at: number;
}

export interface ReplayTurnHooks {
  onYield: (report: ReplayYieldReport) => void;
  onTurnSettled: (sessionIndex: number, turn: number) => void;
}

export class ReplayFactorySession implements FactorySession {
  readonly prompts: string[] = [];
  readonly notifications = new Set<unknown>();
  initResult: FactorySession['initResult'];

  constructor(
    readonly sessionId: string,
    private readonly handlers: RuntimeHandlers,
    private readonly turns: ReplayTurnPlan[],
    private readonly hooks: ReplayTurnHooks,
  ) {
    this.initResult = InitializeSessionResultSchema.parse({
      sessionId,
      session: {},
      settings: {
        modelId: 'model-default',
        reasoningEffort: SdkReasoningEffort.Medium,
      },
    });
  }

  async *stream(
    prompt: string,
    options: MessageOptions & { includePartialMessages: true },
  ): AsyncGenerator<DroidStreamEvent, void, undefined> {
    void options;
    const turnIndex = this.prompts.length;
    this.prompts.push(prompt);
    const plan = this.turns.at(turnIndex);
    if (plan === undefined) {
      yield successfulResultEvent(this.sessionId);
      return;
    }
    const turnStartedAt = performance.now();
    for (const step of plan.steps) {
      const waitMs = step.atMs - (performance.now() - turnStartedAt);
      if (waitMs > 0) await sleep(waitMs);
      this.hooks.onYield({
        sessionIndex: plan.sessionIndex,
        turn: plan.turn,
        marker: step.marker,
        at: performance.timeOrigin + performance.now(),
      });
      yield step.event;
    }
    this.hooks.onYield({
      sessionIndex: plan.sessionIndex,
      turn: plan.turn,
      marker: null,
      at: performance.timeOrigin + performance.now(),
    });
    yield successfulResultEvent(this.sessionId);
    this.hooks.onTurnSettled(plan.sessionIndex, plan.turn);
  }

  onNotification(listener: unknown): () => void {
    this.notifications.add(listener);
    return () => {
      this.notifications.delete(listener);
    };
  }

  close(): Promise<void> {
    this.notifications.clear();
    return Promise.resolve();
  }

  async getContextStats(): ReturnType<FactorySession['getContextStats']> {
    return Promise.resolve({
      used: 0,
      remaining: 1_000,
      limit: 1_000,
      accuracy: ContextStatsAccuracy.Estimated,
      updatedAt: new Date(0).toISOString(),
    });
  }

  readonly interrupt = (): Promise<void> => Promise.resolve();
  readonly updateSettings: FactorySession['updateSettings'] = () => Promise.resolve({});
  readonly enterSpecMode: FactorySession['enterSpecMode'] = () => Promise.resolve({});
  readonly compactSession = (): Promise<{ newSessionId: string; removedCount: number }> =>
    Promise.resolve({ newSessionId: this.sessionId, removedCount: 0 });
  readonly forkSession: FactorySession['forkSession'] = () =>
    Promise.reject(new Error('forkSession is not replayable.'));
  readonly renameSession: FactorySession['renameSession'] = () =>
    Promise.reject(new Error('renameSession is not replayable.'));
  readonly getRewindInfo: FactorySession['getRewindInfo'] = () =>
    Promise.reject(new Error('getRewindInfo is not replayable.'));
  readonly executeRewind: FactorySession['executeRewind'] = () =>
    Promise.reject(new Error('executeRewind is not replayable.'));
  readonly listTools: FactorySession['listTools'] = () =>
    Promise.reject(new Error('listTools is not replayable.'));
  readonly listSkills: FactorySession['listSkills'] = () =>
    Promise.reject(new Error('listSkills is not replayable.'));
  readonly listMcpServers: FactorySession['listMcpServers'] = () =>
    Promise.resolve({
      servers: [],
      summary: { total: 0, connected: 0, connecting: 0, failed: 0, disabled: 0 },
    });
  readonly listMcpTools: FactorySession['listMcpTools'] = () => Promise.resolve({ tools: [] });
  readonly addMcpServer: FactorySession['addMcpServer'] = () => Promise.resolve({ success: true });
  readonly removeMcpServer: FactorySession['removeMcpServer'] = () =>
    Promise.resolve({ success: true });
  readonly toggleMcpServer: FactorySession['toggleMcpServer'] = () =>
    Promise.resolve({ success: true });
  readonly authenticateMcpServer: FactorySession['authenticateMcpServer'] = () =>
    Promise.resolve({ success: true });
}

export class ReplayFactoryRuntime implements FactoryRuntime {
  private readonly sessions: ReplayFactorySession[] = [];

  constructor(
    private readonly turnsBySession: Map<number, ReplayTurnPlan[]>,
    private readonly hooks: ReplayTurnHooks,
  ) {}

  connect(): void {
    // CLI-auth mode needs no credentials for replay.
  }

  status(): RuntimeStatus {
    return { mode: 'cli_auth', droidPath: '/replay/droid', apiKeyConfigured: false };
  }

  createSession(options: CreateRuntimeSessionOptions): Promise<ReplayFactorySession> {
    const index = this.sessions.length;
    const session = new ReplayFactorySession(
      `replay-provider-${String(index)}`,
      options,
      this.turnsBySession.get(index) ?? [],
      this.hooks,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  loadSession(
    providerSessionId: string,
    handlers?: RuntimeHandlers,
  ): Promise<ReplayFactorySession> {
    const existing = this.sessions.find((session) => session.sessionId === providerSessionId);
    if (existing) return Promise.resolve(existing);
    const session = new ReplayFactorySession(providerSessionId, handlers ?? {}, [], this.hooks);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  readContextBreakdown(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  sessionByIndex(index: number): ReplayFactorySession | undefined {
    return this.sessions[index];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

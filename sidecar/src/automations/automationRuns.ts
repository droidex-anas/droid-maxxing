import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '../protocol.js';
import { assertModelSelection, clip, PAUSED_AFTER_FAILURES } from './automationInput.js';
import {
  auditRunSelection,
  failInterruptedRuns,
  newQueuedRun,
  projectActiveRun,
  projectSettledRun,
  sessionCommandForRun,
  type InterruptedRunCleanup,
  type SessionCreateCommand,
} from './automationRunRecord.js';
import { RunTimers } from './automationRunTimers.js';
import { isActiveRunStatus, isSettledRunStatus, trimAutomationStore } from './automationStore.js';
import type {
  Automation,
  AutomationReasoningEffort,
  AutomationRun,
  AutomationRunStatus,
  AutomationStore,
} from './types.js';
import type { AutomationWorkspacePreparer, AutomationWorkspaceReleaser } from './workspace.js';

// A timed-out run whose chat has not arrived yet leaves its reference behind so
// the late chat can be closed. The bound keeps a long uptime from growing the set.
const MAX_ABANDONED_REFS = 32;
const MAX_LAUNCH_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_LAUNCH_RETRY_MS = 400;

type SessionSummary = Extract<ServerEvent, { type: 'session.updated' }>['session'];
type SessionErrorEvent = Extract<ServerEvent, { type: 'error' }>;

export interface AutomationRunsOptions {
  store: () => AutomationStore;
  now: () => number;
  isClosed: () => boolean;
  /** Writes the store and publishes the snapshot. */
  persist: () => Promise<void>;
  /** Applies a store mutation and undoes it when the write fails. */
  commit: (apply: () => void, undo: () => void) => Promise<void>;
  launchSession: (command: SessionCreateCommand) => Promise<void>;
  closeSession: (appSessionId: string) => Promise<void>;
  prepareWorkspace: AutomationWorkspacePreparer;
  releaseWorkspace: AutomationWorkspaceReleaser;
  validateSelection: (modelId: string, reasoningEffort: AutomationReasoningEffort) => Promise<void>;
  /** A settled run frees the schedule, so the next wake is recomputed. */
  rearmScheduler: () => void;
  /** Delay between launch retries. Tests shorten it. */
  launchRetryMs?: number;
}

/**
 * The runs of every automation, from queued to settled.
 *
 * This owns `store.runs`, `store.sessionOrigins`, and the `lastRun*` fields that
 * project a run onto its automation, so a run's state and the summary the UI
 * reads always move together. It runs one automation at a time: the queue drains
 * in request order, each run launches a chat through the bridge, and the run
 * settles from the session events that chat emits, from a timeout, or from a
 * failure to launch at all.
 */
export class AutomationRuns {
  private readonly timers: RunTimers;
  private readonly streamingSeen = new Set<string>();
  private readonly runFailures = new Map<string, string>();
  private readonly abandonedClientRefs = new Set<string>();
  private readonly launchAttempts = new Map<string, number>();
  private readonly launchRetryMs: number;
  private recovered: InterruptedRunCleanup = { appSessionIds: [], workspaces: [] };
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly options: AutomationRunsOptions) {
    this.launchRetryMs = Math.max(0, options.launchRetryMs ?? DEFAULT_LAUNCH_RETRY_MS);
    this.timers = new RunTimers({
      sessionCreateTimedOut: (runId) => {
        void this.retryOrFail(
          runId,
          'DROIDEX did not create the automation chat before the startup timeout.',
        ).catch((error: unknown) => {
          console.error('Could not retry automation launch', error);
        });
      },
      runLimitReached: (runId) => {
        this.timeOut(
          runId,
          'The automation run exceeded the 24-hour safety limit and was stopped in DROIDEX.',
        );
      },
      turnSettled: (runId) => {
        const failure = this.runFailures.get(runId);
        void this.finish(runId, failure ? 'failed' : 'completed', failure ?? null).catch(
          (error: unknown) => {
            console.error('Could not settle automation run', error);
          },
        );
      },
    });
  }

  /** Queues this occurrence unless this automation already has work open. */
  queueScheduled(automation: Automation, scheduledAt: number): void {
    if (this.hasOpenFor(automation.id)) return;
    const queued = this.runs.some(
      (run) =>
        run.automationId === automation.id &&
        run.trigger === 'schedule' &&
        run.scheduledAt === scheduledAt,
    );
    if (queued) return;
    this.runs.push(newQueuedRun(automation, scheduledAt, this.options.now(), 'schedule'));
  }

  /**
   * Queues a run the user asked for. An automation that already has a run
   * waiting or in progress returns that run instead of stacking another.
   */
  async queueManual(automation: Automation): Promise<AutomationRun> {
    assertModelSelection(automation);
    const existing = this.openRunFor(automation.id);
    if (existing) return structuredClone(existing);
    await this.options.validateSelection(automation.modelId, automation.reasoningEffort);
    const pending = this.openRunFor(automation.id);
    if (pending) return structuredClone(pending);
    const requestedAt = this.options.now();
    const run = newQueuedRun(automation, requestedAt, requestedAt, 'manual');
    await this.options.commit(
      () => {
        if (this.hasOpenFor(automation.id)) return;
        this.runs.push(run);
      },
      () => {
        this.store.runs = this.runs.filter((candidate) => candidate.id !== run.id);
      },
    );
    const open = this.openRunFor(automation.id);
    if (!open) throw new Error('Could not queue the automation run.');
    return structuredClone(open);
  }

  /** Starts the next queued run unless one is already running. */
  startQueued(): void {
    if (this.options.isClosed() || this.drainPromise) return;
    // Nothing awaits the drain, so a failure here (a rejected store write) must
    // be reported rather than escape as an unhandled rejection that would take
    // the sidecar - and every live session with it - down.
    this.drainPromise = this.drain()
      .catch((error: unknown) => {
        console.error('Could not start the next automation run', error);
      })
      .finally(() => {
        this.drainPromise = null;
        if (!this.options.isClosed() && !this.activeRun() && this.nextQueuedRun()) {
          this.startQueued();
        }
      });
  }

  /** Advances the run that owns this session event, if any. */
  async applySessionEvent(event: ServerEvent): Promise<void> {
    switch (event.type) {
      case 'session.created':
        await this.adoptSession(event.clientRef, event.session);
        return;
      case 'session.updated':
        this.observeTurn(event.session);
        return;
      case 'event.appended':
        this.observeActivity(event.event.appSessionId);
        return;
      case 'error':
        await this.applyError(event);
        return;
      case 'session.closed':
        await this.applySessionClosed(event.appSessionId);
        return;
      default:
        return;
    }
  }

  activeRunId(): string | null {
    return this.activeRun()?.id ?? null;
  }

  hasActiveFor(automationId: string): boolean {
    return this.runs.some(
      (run) => run.automationId === automationId && isActiveRunStatus(run.status),
    );
  }

  hasOpenFor(automationId: string): boolean {
    return this.openRunFor(automationId) !== undefined;
  }

  private openRunFor(automationId: string): AutomationRun | undefined {
    return this.runs.find(
      (run) =>
        run.automationId === automationId &&
        (run.status === 'queued' || isActiveRunStatus(run.status)),
    );
  }

  /** The run list as it stands, for a caller that has to undo its own mutation. */
  capture(): AutomationRun[] {
    return this.runs.slice();
  }

  restore(runs: AutomationRun[]): void {
    this.store.runs = runs;
  }

  /** Drops the schedule-triggered runs waiting on a schedule that just changed. */
  dropQueuedSchedules(automationId: string): void {
    this.store.runs = this.runs.filter(
      (run) =>
        run.automationId !== automationId || run.status !== 'queued' || run.trigger !== 'schedule',
    );
  }

  /** One open run per automation: extra queued copies from an older process are dropped. */
  private dropExtraQueued(): void {
    const open = new Set<string>();
    for (const run of this.runs) {
      if (isActiveRunStatus(run.status)) open.add(run.automationId);
    }
    const kept: AutomationRun[] = [];
    for (const run of this.runs) {
      if (run.status !== 'queued') {
        kept.push(run);
        continue;
      }
      if (open.has(run.automationId)) continue;
      open.add(run.automationId);
      kept.push(run);
    }
    this.store.runs = kept;
  }

  private pauseAfterConsecutiveFailures(automationId: string): void {
    if (consecutiveFailures(this.runs, automationId) < MAX_CONSECUTIVE_FAILURES) return;
    const automation = this.automationFor(automationId);
    if (!automation?.enabled) return;
    automation.enabled = false;
    automation.nextRunAt = null;
    automation.lastRunError = PAUSED_AFTER_FAILURES;
    automation.updatedAt = this.options.now();
    this.dropQueuedSchedules(automationId);
  }

  dropAllFor(automationId: string): void {
    this.store.runs = this.runs.filter((run) => run.automationId !== automationId);
  }

  /** Fails the runs a previous process left in flight. */
  failInterrupted(now: number): void {
    this.recovered = failInterruptedRuns(this.store, now);
    this.dropExtraQueued();
  }

  /** Closes the chats and removes the worktrees `failInterrupted` reported. */
  async releaseRecovered(): Promise<void> {
    const recovered = this.recovered;
    this.recovered = { appSessionIds: [], workspaces: [] };
    for (const appSessionId of recovered.appSessionIds) {
      await this.closeSessionQuietly(appSessionId);
    }
    for (const workspace of recovered.workspaces) await this.options.releaseWorkspace(workspace);
  }

  /** The drain already in flight, so shutdown can wait for it. */
  pending(): Promise<void> | null {
    return this.drainPromise;
  }

  /** Stops watching every run. Live chats keep running; DROIDEX is exiting. */
  stop(): void {
    this.timers.clearAll();
    this.streamingSeen.clear();
    this.runFailures.clear();
    this.abandonedClientRefs.clear();
    this.launchAttempts.clear();
  }

  private async drain(): Promise<void> {
    while (!this.options.isClosed()) {
      if (this.activeRun()) return;
      const run = this.nextQueuedRun();
      if (!run) return;
      await this.startRun(run);
      if (isActiveRunStatus(run.status)) return;
    }
  }

  private async startRun(run: AutomationRun): Promise<void> {
    try {
      assertModelSelection(run.automation);
      await this.options.validateSelection(run.automation.modelId, run.automation.reasoningEffort);
    } catch (error) {
      await this.finish(run.id, 'failed', errorMessage(error));
      return;
    }
    const now = this.options.now();
    run.status = 'starting';
    run.startedAt = now;
    run.finishedAt = null;
    run.appSessionId = null;
    run.resolvedCwd = null;
    run.error = null;
    this.projectRun(run, 'starting', now);
    try {
      await this.options.persist();
      const resolvedCwd = await this.options.prepareWorkspace({
        cwd: run.automation.workspaceCwd,
        executionMode: run.automation.executionMode,
        title: run.automation.title,
        runId: run.id,
      });
      const current = this.runById(run.id);
      if (this.options.isClosed() || current?.status !== 'starting') {
        await this.options.releaseWorkspace({
          resolvedCwd,
          executionMode: run.automation.executionMode,
        });
        return;
      }
      current.resolvedCwd = resolvedCwd;
    } catch (error) {
      await this.finish(run.id, 'failed', errorMessage(error));
      return;
    }
    await this.launchChat(run.id);
  }

  private async launchChat(runId: string): Promise<void> {
    const run = this.runById(runId);
    if (run?.status !== 'starting' || this.options.isClosed()) return;
    const attempt = (this.launchAttempts.get(runId) ?? 0) + 1;
    this.launchAttempts.set(runId, attempt);
    if (run.clientRef) this.abandonClientRef(run.clientRef);
    run.clientRef = `automation:${runId}:${randomUUID()}`;
    this.timers.armSessionCreate(runId);
    try {
      await this.options.launchSession(sessionCommandForRun(run));
    } catch (error) {
      await this.retryOrFail(runId, errorMessage(error));
    }
  }

  private async retryOrFail(runId: string, message: string): Promise<void> {
    const run = this.runById(runId);
    if (!run || isSettledRunStatus(run.status)) return;
    if (run.appSessionId || (this.launchAttempts.get(runId) ?? 0) >= MAX_LAUNCH_ATTEMPTS) {
      await this.finish(runId, 'failed', message);
      return;
    }
    this.timers.clearSessionCreate(runId);
    if (run.clientRef) {
      this.abandonClientRef(run.clientRef);
      run.clientRef = null;
    }
    await delay(this.launchRetryMs);
    await this.launchChat(runId);
  }

  private async adoptSession(
    clientRef: string | undefined,
    session: SessionSummary,
  ): Promise<void> {
    const run = this.runs.find(
      (candidate) => candidate.clientRef === clientRef && candidate.status === 'starting',
    );
    if (!run) {
      // The run this chat belongs to already gave up on it, so nothing owns the
      // chat and it must not keep running unattended.
      if (clientRef && this.abandonedClientRefs.delete(clientRef)) {
        await this.closeSessionQuietly(session.appSessionId);
      }
      return;
    }
    this.timers.clearSessionCreate(run.id);
    const now = this.options.now();
    run.status = 'running';
    run.appSessionId = session.appSessionId;
    run.error = null;
    this.applySelectionAudit(run, session);
    this.timers.armRunLimit(run.id);
    this.store.sessionOrigins[session.appSessionId] = {
      automationId: run.automationId,
      automationTitle: run.automation.title,
      runId: run.id,
      trigger: run.trigger,
    };
    this.projectRun(run, 'running', now);
    await this.options.persist();
  }

  /**
   * A turn that stopped streaming ends the run, but only once the run has been
   * seen streaming: the first update can arrive before the chat starts working.
   */
  private observeTurn(session: SessionSummary): void {
    const run = this.runForSession(session.appSessionId);
    if (run?.status !== 'running') return;
    this.applySelectionAudit(run, session);
    if (session.streaming === true) {
      this.streamingSeen.add(run.id);
      this.timers.clearTurnSettle(run.id);
      return;
    }
    if (session.streaming === false && this.streamingSeen.has(run.id)) {
      this.timers.armTurnSettle(run.id);
    }
  }

  private observeActivity(appSessionId: string): void {
    const run = this.runForSession(appSessionId);
    if (run?.status !== 'running') return;
    this.streamingSeen.add(run.id);
    this.timers.clearTurnSettle(run.id);
  }

  private async applyError(event: SessionErrorEvent): Promise<void> {
    const starting = event.clientRef
      ? this.runs.find((run) => run.clientRef === event.clientRef && run.status === 'starting')
      : undefined;
    if (starting) {
      await this.finish(starting.id, 'failed', event.message);
      return;
    }
    const running = event.appSessionId ? this.runForSession(event.appSessionId) : undefined;
    if (!running || event.recoverable === true || running.status !== 'running') return;
    this.runFailures.set(running.id, clip(event.message, 2_000));
    this.timers.armTurnSettle(running.id);
  }

  private async applySessionClosed(appSessionId: string): Promise<void> {
    const run = this.runForSession(appSessionId);
    if (!run || !isActiveRunStatus(run.status)) return;
    const failure = this.runFailures.get(run.id);
    if (failure) {
      await this.finish(run.id, 'failed', failure);
      return;
    }
    if (this.timers.isTurnSettleArmed(run.id)) {
      await this.finish(run.id, 'completed', null);
      return;
    }
    await this.finish(
      run.id,
      'failed',
      this.streamingSeen.has(run.id)
        ? 'The automation chat closed before its turn finished.'
        : 'The automation chat closed before its first turn finished.',
    );
  }

  private async finish(
    runId: string,
    status: Extract<AutomationRunStatus, 'completed' | 'failed'>,
    error: string | null,
  ): Promise<void> {
    const run = this.runById(runId);
    if (!run || isSettledRunStatus(run.status)) return;

    this.timers.clearRun(runId);
    this.streamingSeen.delete(runId);
    this.runFailures.delete(runId);
    this.launchAttempts.delete(runId);

    const now = this.options.now();
    const clientRef = run.clientRef;
    run.status = status;
    run.finishedAt = now;
    run.error = status === 'failed' ? clip(error ?? 'Automation run failed.', 2_000) : null;
    const automation = this.automationFor(run.automationId);
    if (automation) projectSettledRun(automation, run, now);
    if (status === 'failed') this.pauseAfterConsecutiveFailures(run.automationId);
    if (status === 'failed' && !run.appSessionId && clientRef) {
      this.abandonClientRef(clientRef);
    }
    trimAutomationStore(this.store);
    await this.options.persist();
    await this.options.releaseWorkspace({
      resolvedCwd: run.resolvedCwd,
      executionMode: run.automation.executionMode,
    });
    this.options.rearmScheduler();
    this.startQueued();
  }

  /**
   * Settles a run DROIDEX stopped waiting for and tears down its chat, so a
   * timed-out run cannot leave a session streaming with nothing tracking it.
   */
  private timeOut(runId: string, message: string): void {
    const run = this.runById(runId);
    if (!run || isSettledRunStatus(run.status)) return;
    const appSessionId = run.appSessionId;
    const clientRef = run.clientRef;
    void this.finish(runId, 'failed', message)
      .then(async () => {
        if (appSessionId) {
          await this.closeSessionQuietly(appSessionId);
          return;
        }
        if (clientRef) this.abandonClientRef(clientRef);
      })
      .catch((error: unknown) => {
        console.error('Could not time out automation run', error);
      });
  }

  /** Remembers a launch DROIDEX gave up on, so its late chat gets closed. */
  private abandonClientRef(clientRef: string): void {
    this.abandonedClientRefs.add(clientRef);
    while (this.abandonedClientRefs.size > MAX_ABANDONED_REFS) {
      const oldest = this.abandonedClientRefs.values().next().value;
      if (typeof oldest !== 'string') break;
      this.abandonedClientRefs.delete(oldest);
    }
  }

  private async closeSessionQuietly(appSessionId: string): Promise<void> {
    try {
      await this.options.closeSession(appSessionId);
    } catch (error) {
      console.error('Could not close an orphaned automation chat', error);
    }
  }

  /** A run that drifted off its selected model fails with what it actually ran. */
  private applySelectionAudit(
    run: AutomationRun,
    session: { modelId?: string; reasoningEffort?: unknown },
  ): void {
    const mismatch = auditRunSelection(run, session);
    if (mismatch) this.runFailures.set(run.id, mismatch);
  }

  /** Keeps the automation summary in step with the run that is on its way. */
  private projectRun(run: AutomationRun, status: 'starting' | 'running', at: number): void {
    const automation = this.automationFor(run.automationId);
    if (automation) projectActiveRun(automation, run, status, at);
  }

  private runById(runId: string): AutomationRun | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  private activeRun(): AutomationRun | undefined {
    return this.runs.find((run) => isActiveRunStatus(run.status));
  }

  private nextQueuedRun(): AutomationRun | undefined {
    let next: AutomationRun | undefined;
    for (const run of this.runs) {
      if (run.status !== 'queued') continue;
      if (!next || run.requestedAt < next.requestedAt) next = run;
    }
    return next;
  }

  /**
   * The live run that owns a chat, if the chat belongs to one at all.
   *
   * `sessionOrigins` records that link when a run adopts its chat, so an event
   * from an ordinary chat - the common case, and by far the most frequent event
   * in DROIDEX - costs one lookup instead of a walk over the run history.
   */
  private runForSession(appSessionId: string): AutomationRun | undefined {
    const origin = this.store.sessionOrigins[appSessionId];
    if (!origin) return undefined;
    const run = this.runById(origin.runId);
    return run && isActiveRunStatus(run.status) ? run : undefined;
  }

  private automationFor(automationId: string): Automation | undefined {
    return this.store.automations.find((candidate) => candidate.id === automationId);
  }

  private get store(): AutomationStore {
    return this.options.store();
  }

  private get runs(): AutomationRun[] {
    return this.store.runs;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function consecutiveFailures(runs: readonly AutomationRun[], automationId: string): number {
  const settled = runs
    .filter((run) => run.automationId === automationId && isSettledRunStatus(run.status))
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
  let count = 0;
  for (const run of settled) {
    if (run.status !== 'failed') break;
    count += 1;
  }
  return count;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

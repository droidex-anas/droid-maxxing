import { join } from 'node:path';
import type { ServerEvent } from '../protocol.js';
import { AutomationCatalog } from './automationCatalog.js';
import { hasModelSelection } from './automationInput.js';
import { AutomationProposals } from './automationProposals.js';
import { type SessionCreateCommand } from './automationRunRecord.js';
import { AutomationRuns } from './automationRuns.js';
import { AutomationScheduler, disableForMissingSelection } from './automationScheduler.js';
import {
  AutomationStoreFile,
  buildAutomationSnapshot,
  emptyAutomationStore,
  trimAutomationStore,
} from './automationStore.js';
import {
  mergeSessionContext,
  SessionContextCache,
  type AutomationSessionContext,
} from './sessionContexts.js';
import type {
  Automation,
  AutomationBridgeCommand,
  AutomationBridgeEvent,
  AutomationInput,
  AutomationPatch,
  AutomationProposal,
  AutomationReasoningEffort,
  AutomationRun,
  AutomationSnapshot,
  AutomationStore,
} from './types.js';
import {
  prepareAutomationWorkspace,
  releaseAutomationWorkspace,
  type AutomationWorkspacePreparer,
  type AutomationWorkspaceReleaser,
} from './workspace.js';

interface AutomationManagerOptions {
  dataDir: string;
  emit: (event: AutomationBridgeEvent) => void;
  launchSession: (command: SessionCreateCommand) => Promise<void>;
  closeSession?: (appSessionId: string) => Promise<void>;
  prepareWorkspace?: AutomationWorkspacePreparer;
  releaseWorkspace?: AutomationWorkspaceReleaser;
  resolveSessionContext?: (appSessionId: string) => Promise<AutomationSessionContext | null>;
  validateSelection?: (
    modelId: string,
    reasoningEffort: AutomationReasoningEffort,
  ) => Promise<void>;
  now?: () => number;
  /** How often the scheduler re-reads the clock while waiting. Tests shorten it. */
  schedulerRecheckMs?: number;
  /** Delay between launch retries. Tests shorten it. */
  launchRetryMs?: number;
}

let configuredManager: AutomationManager | null = null;

export function configureAutomationManager(options: AutomationManagerOptions): AutomationManager {
  if (configuredManager) return configuredManager;
  configuredManager = new AutomationManager(options);
  return configuredManager;
}

export function getAutomationManager(): AutomationManager {
  if (!configuredManager) throw new Error('DROIDEX automations are not initialized.');
  return configuredManager;
}

/**
 * The automations feature: one entry point for the bridge, the MCP tools, and
 * the session events that drive a run.
 *
 * The state itself belongs to four collaborators, each the single writer of its
 * part of the store: `AutomationCatalog` for the definitions,
 * `AutomationScheduler` for when they run next, `AutomationRuns` for the runs and
 * the summary they project onto an automation, and `AutomationProposals` for the
 * review cards in chat. This class holds the pieces they share - the persisted
 * store, the transaction that undoes a mutation when its write fails, the
 * published snapshot, and the load and shutdown sequences - and gates every
 * public operation on the store being loaded.
 */
export class AutomationManager {
  private readonly storeFile: AutomationStoreFile;
  private readonly emit: (event: AutomationBridgeEvent) => void;
  private readonly resolveSessionContext: (
    appSessionId: string,
  ) => Promise<AutomationSessionContext | null>;
  private readonly now: () => number;
  private store: AutomationStore = emptyAutomationStore();
  private readonly sessionContexts = new SessionContextCache();
  private readonly runs: AutomationRuns;
  private readonly scheduler: AutomationScheduler;
  private readonly catalog: AutomationCatalog;
  private readonly proposals: AutomationProposals;
  private readonly ready: Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(options: AutomationManagerOptions) {
    this.storeFile = new AutomationStoreFile(join(options.dataDir, 'automations.json'));
    this.emit = options.emit;
    this.resolveSessionContext = options.resolveSessionContext ?? (() => Promise.resolve(null));
    this.now = options.now ?? Date.now;
    const validateSelection = options.validateSelection ?? (() => Promise.resolve(undefined));
    const shared = {
      store: () => this.store,
      now: () => this.now(),
      commit: (apply: () => void, undo: () => void) => this.commit(apply, undo),
      validateSelection,
    };
    this.runs = new AutomationRuns({
      ...shared,
      isClosed: () => this.closed,
      persist: () => this.persistAndPublish(),
      launchSession: options.launchSession,
      closeSession: options.closeSession ?? (() => Promise.resolve()),
      prepareWorkspace: options.prepareWorkspace ?? prepareAutomationWorkspace,
      releaseWorkspace: options.releaseWorkspace ?? releaseAutomationWorkspace,
      rearmScheduler: () => {
        this.scheduler.arm();
      },
      launchRetryMs: options.launchRetryMs,
    });
    this.scheduler = new AutomationScheduler({
      store: shared.store,
      now: shared.now,
      isClosed: () => this.closed,
      runs: this.runs,
      persist: () => this.persistAndPublish(),
      recheckMs: options.schedulerRecheckMs,
    });
    this.catalog = new AutomationCatalog({
      ...shared,
      sessionContext: (appSessionId) => this.resolvedContext(appSessionId),
      runs: this.runs,
    });
    this.proposals = new AutomationProposals({
      ...shared,
      sessionContext: (appSessionId) => this.resolvedContext(appSessionId),
      automations: this.catalog,
    });
    this.ready = this.initialize();
    void this.ready
      .then(async () => {
        await this.runs.releaseRecovered();
        this.runs.startQueued();
      })
      .catch((error: unknown) => {
        console.error('Could not initialize DROIDEX automations', error);
      });
  }

  async snapshot(): Promise<AutomationSnapshot> {
    await this.ready;
    return this.snapshotNow();
  }

  async publishSnapshot(): Promise<void> {
    this.emit({ type: 'automations.snapshot', snapshot: await this.snapshot() });
  }

  async create(input: AutomationInput): Promise<Automation> {
    await this.ready;
    return this.catalog.create(input);
  }

  async createFromSession(input: AutomationInput, sourceAppSessionId: string): Promise<Automation> {
    await this.ready;
    return this.catalog.createFromSession(input, sourceAppSessionId);
  }

  async update(id: string, patch: AutomationPatch): Promise<Automation> {
    await this.ready;
    return this.catalog.update(id, patch);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation> {
    return this.update(id, { enabled });
  }

  /**
   * Deletes an automation, its runs, and the link its proposals hold to it. The
   * three collections settle in one write, so a card in chat can never point at
   * an automation that is already gone.
   */
  async remove(id: string): Promise<void> {
    await this.ready;
    this.catalog.require(id);
    if (this.runs.hasActiveFor(id)) {
      throw new Error('Wait for the active automation run to finish before deleting it.');
    }
    const previousAutomations = this.catalog.capture();
    const previousRuns = this.runs.capture();
    const previousProposals = this.proposals.capturedForAutomation(id);
    await this.commit(
      () => {
        this.catalog.discard(id);
        this.proposals.unlinkAutomation(id, this.now());
      },
      () => {
        this.catalog.restore(previousAutomations);
        this.runs.restore(previousRuns);
        this.proposals.restore(previousProposals);
      },
    );
  }

  async runNow(id: string): Promise<AutomationRun> {
    await this.ready;
    return this.runs.queueManual(this.catalog.require(id));
  }

  async propose(input: AutomationInput, sourceAppSessionId: string): Promise<AutomationProposal> {
    await this.ready;
    return this.proposals.propose(input, sourceAppSessionId);
  }

  async confirmProposal(id: string, input?: AutomationInput): Promise<Automation> {
    await this.ready;
    return this.proposals.confirm(id, input);
  }

  /**
   * Observe session lifecycle events. Callers fire these without awaiting;
   * shutdown waits for tracked work instead of exiting mid-teardown.
   *
   * `event.appended` is the streaming hot path. An ordinary chat is one origin
   * lookup and never enters the async observer.
   */
  observeSessionEvent(event: ServerEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (event.type === 'event.appended' && !this.store.sessionOrigins[event.event.appSessionId]) {
      return Promise.resolve();
    }
    return this.track(this.handleSessionEvent(event));
  }

  async handleBridgeCommand(value: unknown): Promise<boolean> {
    if (!isAutomationCommand(value)) return false;
    const command = value;
    try {
      await this.runCommand(command);
      this.emit({ type: 'automations.result', requestId: command.requestId, ok: true });
    } catch (error) {
      this.emit({
        type: 'automations.result',
        requestId: command.requestId,
        ok: false,
        error: errorMessage(error),
      });
    }
    return true;
  }

  /**
   * Stops scheduling and settles pending writes; live sessions keep running.
   * Closing sessions emits lifecycle events whose observers settle runs and
   * remove their isolated worktrees, so that work is awaited here: the process
   * exits right after and would otherwise leave the worktree behind.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.scheduler.stop();
    this.runs.stop();
    this.sessionContexts.clear();
    await this.settleInFlightWork();
    await this.storeFile.flush();
  }

  private async runCommand(command: AutomationBridgeCommand): Promise<void> {
    switch (command.type) {
      case 'automations.list':
        await this.publishSnapshot();
        return;
      case 'automations.create':
        await this.create(command.input);
        return;
      case 'automations.update':
        await this.update(command.id, command.patch);
        return;
      case 'automations.delete':
        await this.remove(command.id);
        return;
      case 'automations.setEnabled':
        await this.setEnabled(command.id, command.enabled);
        return;
      case 'automations.runNow':
        await this.runNow(command.id);
        return;
      case 'automations.confirmProposal':
        await this.confirmProposal(command.id, command.input);
        return;
      default: {
        const type = (command as { type: string }).type;
        throw new Error(`Unknown automations command: ${type}`);
      }
    }
  }

  private async handleSessionEvent(event: ServerEvent): Promise<void> {
    await this.ready;
    if (this.closed) return;
    if (event.type === 'session.created' || event.type === 'session.updated') {
      this.sessionContexts.observe(event.session);
    }
    await this.runs.applySessionEvent(event);
  }

  /**
   * Waits for the observers and the run drain already in flight. Settling a run
   * starts follow-up work (a store write, a worktree release), so the wait
   * repeats; the pass limit keeps a misbehaving observer from blocking exit.
   */
  private async settleInFlightWork(): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
      const pending = [...this.inFlight];
      const drain = this.runs.pending();
      if (drain) pending.push(drain);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private track(work: Promise<void>): Promise<void> {
    const tracked = work.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  /**
   * Loads the store and repairs what the previous process left behind: an
   * automation without a model selection stops being scheduled, and a run that
   * was in flight is failed so the queue starts clean.
   */
  private async initialize(): Promise<void> {
    this.store = await this.storeFile.read(this.now());
    const now = this.now();
    for (const automation of this.store.automations) {
      if (!automation.enabled || hasModelSelection(automation)) continue;
      disableForMissingSelection(automation, now);
    }
    this.runs.failInterrupted(now);
    this.scheduler.processDue();
    trimAutomationStore(this.store);
    await this.storeFile.write(this.store);
    this.scheduler.arm();
  }

  /**
   * Applies a store mutation and undoes it when the write fails, so a rejected
   * request cannot leave a record that exists only in memory. Undo restores the
   * records this operation touched; scheduling progress recomputed for other
   * automations stays consistent with the runs held in memory.
   */
  private async commit(apply: () => void, undo: () => void): Promise<void> {
    apply();
    try {
      this.scheduler.processDue();
      trimAutomationStore(this.store);
      await this.persistAndPublish();
      this.scheduler.arm();
      this.runs.startQueued();
    } catch (error) {
      undo();
      this.emit({ type: 'automations.snapshot', snapshot: this.snapshotNow() });
      throw error;
    }
  }

  private async persistAndPublish(): Promise<void> {
    await this.storeFile.write(this.store);
    this.emit({ type: 'automations.snapshot', snapshot: this.snapshotNow() });
  }

  private async resolvedContext(appSessionId: string): Promise<AutomationSessionContext | null> {
    return mergeSessionContext(
      this.sessionContexts.get(appSessionId),
      await this.resolveSessionContext(appSessionId),
    );
  }

  private snapshotNow(): AutomationSnapshot {
    return buildAutomationSnapshot(this.store, {
      ready: !this.closed,
      nextWakeAt: this.scheduler.nextWakeAt(),
      activeRunId: this.runs.activeRunId(),
    });
  }
}

function isAutomationCommand(value: unknown): value is AutomationBridgeCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { type?: unknown; requestId?: unknown };
  return (
    typeof candidate.type === 'string' &&
    candidate.type.startsWith('automations.') &&
    typeof candidate.requestId === 'string'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

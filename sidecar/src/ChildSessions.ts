import { factoryReasoningEffort } from './providers/droid/DroidModeMapping.js';
import { requireDroidCapability } from './providers/droid/droidCapabilityGate.js';
import type { PersistedChildSession, PersistedChildSpawnLink } from './ChildSessionState.js';
import type { ChildSessionSummary, ClientCommand } from './protocol.js';
import {
  matchesChildGenerationSnapshot,
  type AutoCompactionSettlement,
  type ChildAutomaticCompactionTarget,
  type ChildCompactionTarget,
  type CompactionResourceKey,
  type CompactionRetuneTarget,
} from './SessionCompaction.js';
import { errMsg, isUserCancellation } from './sessionHelpers.js';
import { isReportedStreamingTranscriptError } from './SessionTimeline.js';
import type { ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  applyObservedChild,
  childAcceptsWork,
  childDurabilityKey,
  childHistoryProviderSessionIds,
  childIdentity,
  childStateFromRecord,
  childSummary,
  findChildByProvider,
  findChildBySpawn,
  findPendingChildObservation,
  forgetPendingChildObservation,
  mergeChildObservations,
  childContextTarget,
  newChildState,
  persistedChild,
  rememberPendingChildObservation,
  restoredChildStatus,
  type ChildIdentity,
  type ChildRuntimeState,
  type ChildRuntimeTarget,
  type ChildSettings,
  type ChildSessionState,
  type ChildSpawnObservation,
  type ParentChildSessions,
} from './ChildSessionState.js';
import type {
  ChildOperation,
  ChildSessionsDependencies,
  ChildSettingsTarget,
} from './ChildSessionsTypes.js';
import {
  childRuntimeLimits,
  decideChildRuntimeCapacity,
  enqueueChildRuntime,
  takeNextQueuedChild,
} from './childRuntimeBudget.js';
import {
  CHILD_RUNTIME_RETIRED_STATUS,
  nextChildRuntimeRetirementAt,
  parentHasUnsettledChildren,
  retirableChildRuntimes,
} from './childRuntimeRetirement.js';
import {
  cancelOpenAttempts,
  installChildRuntime,
  openChildHistory,
  type ChildRuntimeInstallHost,
} from './childRuntimeOpen.js';
import { RuntimeRetirementTimer } from './runtimeRetirementTimer.js';
import { childTokenStream } from './childStreamFidelity.js';
import { dequeueQueuedChild, prepareChildInterrupt } from './childTurnCancellation.js';

type ChildSettingsCommand = Extract<ClientCommand, { type: 'child.updateSettings' }>;
type ChildLoadHistoryCommand = Extract<ClientCommand, { type: 'child.loadHistory' }>;

const ignoreError = (): undefined => undefined;
const runCleanup = (operation: () => void | Promise<void>) =>
  Promise.resolve().then(operation).catch(ignoreError);

export class ChildSessions {
  private readonly parents = new Map<string, ParentChildSessions>();
  private readonly childrenAwaitingDurability = new Map<
    string,
    { child: ChildSessionState; closeAfterPublish: boolean }
  >();
  private nextParentGeneration = 0;
  private shuttingDown = false;
  private readonly retirementTimer = new RuntimeRetirementTimer(() => {
    void this.retireIdleRuntimes();
  });

  constructor(private readonly d: ChildSessionsDependencies) {}

  attachParent(parentAppSessionId: string): void {
    const lease = this.d.registry.getLive(parentAppSessionId);
    if (lease?.summary.appSessionId !== parentAppSessionId)
      throw new Error(`Cannot attach child sessions to missing parent ${parentAppSessionId}.`);
    const current = this.parents.get(parentAppSessionId);
    if (current?.lease === lease && !current.closing) return;
    if (current)
      throw new Error(`Child sessions are already attached to a different ${parentAppSessionId}.`);
    const parent: ParentChildSessions = {
      parentAppSessionId,
      generation: ++this.nextParentGeneration,
      lease,
      children: new Map(),
      pendingSpawns: new Map(),
      openAttempts: new Map(),
      reservedOpenSlots: new Set(),
      runtimeQueue: [],
      closing: false,
    };
    for (const record of this.d.childPersistence.list(parentAppSessionId))
      parent.children.set(record.childSessionId, childStateFromRecord(record));
    this.parents.set(parentAppSessionId, parent);
  }

  list(parentAppSessionId: string): ChildSessionSummary[] {
    const parent = this.parents.get(parentAppSessionId);
    if (parent) return [...parent.children.values()].map(childSummary);
    return this.d.childPersistence
      .list(parentAppSessionId)
      .map((record) => childSummary({ ...record, status: restoredChildStatus(record.status) }));
  }

  counts(): { total: number; active: number; live: number; queued: number } {
    let total = 0;
    let active = 0;
    let live = 0;
    let queued = 0;
    for (const parent of this.parents.values()) {
      for (const child of parent.children.values()) {
        total += 1;
        if (childAcceptsWork(child)) active += 1;
        if (child.runtime) live += 1;
        if (child.queued) queued += 1;
      }
    }
    return { total, active, live, queued };
  }

  hasUnsettledChildren(parentAppSessionId: string): boolean {
    return parentHasUnsettledChildren(this.parents.get(parentAppSessionId), (child) =>
      this.childrenAwaitingDurability.has(childDurabilityKey(child.identity)),
    );
  }

  liveChildSummaries(): ChildSessionSummary[] {
    const summaries: ChildSessionSummary[] = [];
    for (const parent of this.parents.values()) {
      for (const child of parent.children.values()) summaries.push(childSummary(child));
    }
    return summaries;
  }

  admitChildObservation(observation: ChildSpawnObservation): ChildIdentity | undefined {
    const parent = this.parents.get(observation.parentAppSessionId);
    if (!parent || !this.isCurrentParent(parent)) return undefined;
    const pending = findPendingChildObservation(parent, observation);
    const observed = mergeChildObservations(pending, observation);
    const spawnLink = observed.spawnLink;
    if (!observed.providerSessionId) {
      const child = spawnLink ? findChildBySpawn(parent, spawnLink) : undefined;
      if (observed.done && child) this.complete(parent, child);
      else if (spawnLink) rememberPendingChildObservation(parent, pending, observed);
      return undefined;
    }
    const providerSessionId = observed.providerSessionId;
    for (const child of parent.children.values())
      if (child.retiredProviderSessionIds.has(providerSessionId)) return undefined;

    const spawnChild = spawnLink ? findChildBySpawn(parent, spawnLink) : undefined;
    const providerChild = findChildByProvider(parent, providerSessionId);
    if (spawnChild && providerChild && spawnChild !== providerChild) return undefined;
    if (observed.done && providerChild) {
      if (spawnLink && spawnChild !== providerChild) return undefined;
      forgetPendingChildObservation(parent, pending);
      this.complete(parent, providerChild);
      return undefined;
    }

    const existingChild = spawnChild ?? providerChild;
    const existingProviderSessionId =
      existingChild?.runtime?.session.sessionId ?? existingChild?.providerSessionId;
    const needsExactSettings =
      observed.requiresExactLaunchSettings === true &&
      (!existingChild || existingProviderSessionId !== providerSessionId);
    if (needsExactSettings && !observed.modelId) {
      const firstProviderObservation = !pending?.providerSessionId;
      const firstTerminalObservation = observed.done === true && pending?.done !== true;
      if (firstProviderObservation || firstTerminalObservation) {
        const launchSettings = this.readLaunchSettings(providerSessionId);
        if (launchSettings) {
          observed.modelId = launchSettings.modelId;
          observed.reasoningEffort = launchSettings.reasoningEffort;
        }
      }
      if (!observed.modelId) {
        rememberPendingChildObservation(parent, pending, observed);
        return undefined;
      }
    }

    const child =
      spawnChild ??
      providerChild ??
      this.createChild(parent, observed.role, spawnLink, observed, needsExactSettings);
    forgetPendingChildObservation(parent, pending);
    // Poll-style observations (TaskOutput) carry their own call's tool_use id,
    // not the spawn's; only a link that matched an observed spawn call (pending)
    // may key a child that already has one. Trusting the poll's id would rekey
    // the child away from the transcript event its UI row is anchored to.
    const linkForApply = pending || !child.spawnLink ? spawnLink : child.spawnLink;
    const previousProviderSessionId = child.runtime?.session.sessionId ?? child.providerSessionId;
    if (previousProviderSessionId && previousProviderSessionId !== providerSessionId) {
      child.retiredProviderSessionIds.add(previousProviderSessionId);
      void this.closeRuntime(parent, child, false);
    }
    const apply = () => {
      if (!this.isCurrentChild(parent, child) || !childAcceptsWork(child)) return;
      if (child.retiredProviderSessionIds.has(providerSessionId)) return;
      if (child.role !== observed.role && child.turn.autoCompacting)
        this.d.compaction.cancel(this.automaticTarget(parent, child));
      const { previousPrompt } = applyObservedChild(
        child,
        observed,
        linkForApply,
        providerSessionId,
        this.d.now(),
      );
      if (observed.done) this.complete(parent, child);
      else this.commit(child);
      if (child.prompt && child.prompt !== previousPrompt)
        this.d.timeline.appendStatus(
          child.identity.parentAppSessionId,
          `Task prompt\n\n${child.prompt}`,
          undefined,
          child.identity.childSessionId,
          child.role,
        );
    };
    if (child.mutationTail || child.role !== observed.role) {
      const update = (child.mutationTail ?? Promise.resolve()).catch(ignoreError).then(apply);
      child.mutationTail = update;
      void update.finally(() => this.clearMutation(child, update)).catch(ignoreError);
    } else apply();
    return observed.done ? undefined : child.identity;
  }

  retryPendingLaunchSettings(providerSessionIds?: readonly string[]): void {
    const requested = providerSessionIds ? new Set(providerSessionIds) : undefined;
    for (const parent of this.parents.values()) {
      if (!this.isCurrentParent(parent)) continue;
      for (const pending of parent.pendingSpawns.values()) {
        const providerSessionId = pending.providerSessionId;
        if (
          !pending.requiresExactLaunchSettings ||
          !providerSessionId ||
          pending.modelId ||
          (requested && !requested.has(providerSessionId))
        )
          continue;
        const settings = this.readLaunchSettings(providerSessionId);
        if (settings)
          this.admitChildObservation({
            ...pending,
            modelId: settings.modelId,
            reasoningEffort: settings.reasoningEffort,
          });
      }
    }
  }

  retryPendingDurability(): void {
    for (const [key, pending] of this.childrenAwaitingDurability) {
      const parent = this.parents.get(pending.child.identity.parentAppSessionId);
      if (!parent || !this.isCurrentChild(parent, pending.child)) {
        this.childrenAwaitingDurability.delete(key);
        continue;
      }
      this.childrenAwaitingDurability.delete(key);
      this.publish(pending.child);
      if (pending.closeAfterPublish) void this.closeWhenIdle(pending.child.identity);
    }
  }

  async open(command: Extract<ClientCommand, { type: 'child.open' }>): Promise<void> {
    const { parentAppSessionId, childSessionId, requestId } = command;
    await this.openFor(parentAppSessionId, childSessionId, requestId, 'open');
  }

  async loadHistory(command: ChildLoadHistoryCommand): Promise<void> {
    const identity = childIdentity(command.parentAppSessionId, command.childSessionId);
    const parent = this.parents.get(command.parentAppSessionId);
    const child = parent?.children.get(command.childSessionId);
    if (parent && this.isCurrentParent(parent) && child) {
      if (child.mutationTail) {
        await child.mutationTail;
        if (!this.isCurrentParent(parent)) return;
        const current = parent.children.get(command.childSessionId);
        if (!current) return;
        this.d.timeline.loadChildHistory({
          appSessionId: command.parentAppSessionId,
          childSessionId: command.childSessionId,
          childProviderSessionIds: childHistoryProviderSessionIds(current),
          role: current.role,
          cursor: command.cursor,
          limit: command.limit,
        });
        return;
      }
      this.d.timeline.loadChildHistory({
        appSessionId: command.parentAppSessionId,
        childSessionId: command.childSessionId,
        childProviderSessionIds: childHistoryProviderSessionIds(child),
        role: child.role,
        cursor: command.cursor,
        limit: command.limit,
      });
      return;
    }

    const record = this.d.childPersistence.get(command.parentAppSessionId, command.childSessionId);
    if (!record) {
      this.emitError(
        identity,
        'loadHistory',
        null,
        'child.not_in_session',
        `Child session ${command.childSessionId} is not tied to session ${command.parentAppSessionId}.`,
      );
      return;
    }
    this.d.timeline.loadChildHistory({
      appSessionId: command.parentAppSessionId,
      childSessionId: command.childSessionId,
      childProviderSessionIds: childHistoryProviderSessionIds(record),
      role: record.role,
      cursor: command.cursor,
      limit: command.limit,
    });
  }

  async send(identity: ChildIdentity, text: string): Promise<void> {
    const queuedParent = this.parents.get(identity.parentAppSessionId);
    const queuedChild = queuedParent?.children.get(identity.childSessionId);
    if (queuedParent && queuedChild?.queued) {
      queuedChild.turn.pendingSends.push(text);
      return;
    }
    const target = await this.requireRuntime(identity, 'send');
    if (!target) return;
    const { parent, child, runtime } = target;
    runtime.lastUsedAt = this.d.now();
    if (child.turn.phase === 'streaming' || child.turn.autoCompacting) {
      child.turn.pendingSends.push(text);
      return;
    }
    await this.drive(parent, child, text);
  }

  async sendNow(identity: ChildIdentity, text: string): Promise<void> {
    const queuedParent = this.parents.get(identity.parentAppSessionId);
    const queuedChild = queuedParent?.children.get(identity.childSessionId);
    if (queuedParent && queuedChild?.queued) {
      queuedChild.turn.pendingSends.unshift(text);
      return;
    }
    const target = await this.requireRuntime(identity, 'sendNow');
    if (!target) return;
    const { parent, child, runtime } = target;
    runtime.lastUsedAt = this.d.now();
    if (child.turn.phase === 'idle' && !child.turn.autoCompacting) {
      await this.drive(parent, child, text);
      return;
    }
    child.turn.pendingSends.unshift(text);
    if (child.turn.autoCompacting) return;
    const turnGeneration = child.turn.generation;
    child.turn.interruptingForSteer = true;
    this.d.timeline.appendStatus(
      identity.parentAppSessionId,
      'Steering child session now...',
      undefined,
      identity.childSessionId,
      child.role,
    );
    try {
      await runtime.session.interrupt();
    } catch (error) {
      if (!this.isCurrentTurnGeneration(parent, child, runtime, turnGeneration)) return;
      child.turn.interruptingForSteer = false;
      this.emitError(
        identity,
        'sendNow',
        null,
        'child.send_now_failed',
        `Could not interrupt child session for steering: ${errMsg(error)}`,
      );
    }
  }

  async interrupt(identity: ChildIdentity): Promise<void> {
    const parent = this.parents.get(identity.parentAppSessionId);
    const prepared = prepareChildInterrupt(parent, parent?.children.get(identity.childSessionId));
    if (prepared.kind === 'missing') {
      await this.requireRuntime(identity, 'interrupt');
      return;
    }
    if (prepared.kind === 'queued') {
      this.publish(prepared.child);
      const attempt = prepared.parent.openAttempts.get(identity.childSessionId);
      if (attempt) await attempt.settled;
      return;
    }
    const { parent: liveParent, child, runtime } = prepared;
    runtime.lastUsedAt = this.d.now();
    const wasAutoCompacting = child.turn.autoCompacting;
    const turnGeneration = child.turn.generation;
    child.turn.interrupting = true;
    try {
      await runtime.session.interrupt();
    } catch (error) {
      if (!this.isCurrentTurnGeneration(liveParent, child, runtime, turnGeneration)) return;
      child.turn.interrupting = false;
      this.emitError(identity, 'interrupt', null, 'child.interrupt_failed', errMsg(error));
      return;
    }
    if (!this.isCurrentTurnGeneration(liveParent, child, runtime, turnGeneration)) return;
    if (wasAutoCompacting) this.d.compaction.cancel(this.automaticTarget(liveParent, child));
    if (child.turn.phase === 'streaming') return;
    child.turn.interrupting = false;
    child.status = 'paused';
    this.commit(child);
  }

  async updateSettings(command: ChildSettingsCommand): Promise<void> {
    const parent = this.parents.get(command.parentAppSessionId);
    if (parent) requireDroidCapability(parent.lease, 'modelChange', 'child.updateSettings');
    const child = parent?.children.get(command.childSessionId);
    if (
      !parent ||
      !child ||
      !Object.hasOwn(command, 'modelId') ||
      !this.isSettingsTarget(parent, child)
    ) {
      this.emitError(
        childIdentity(command.parentAppSessionId, command.childSessionId),
        'settings',
        null,
        'child.settings_target_invalid',
        `Child session ${command.childSessionId || '(missing)'} is not an active settings target for ${command.parentAppSessionId || '(missing)'}.`,
      );
      return;
    }
    const runtime = child.runtime;
    if (!runtime) return;
    const target = {
      parent,
      child,
      runtime,
      parentGeneration: parent.generation,
      runtimeGeneration: runtime.generation,
    };
    const update = (child.mutationTail ?? Promise.resolve())
      .catch(ignoreError)
      .then(() => this.performSettingsUpdate(target, command));
    child.mutationTail = update;
    try {
      await update;
    } finally {
      this.clearMutation(child, update);
    }
  }

  compactionRetuneTargets(): readonly CompactionRetuneTarget[] {
    const targets: CompactionRetuneTarget[] = [];
    for (const parent of this.parents.values())
      for (const child of parent.children.values())
        if (child.runtime) targets.push(this.compactionTarget(parent, child, child.modelId));
    return targets;
  }

  resolveAutomaticTarget(key: CompactionResourceKey): ChildAutomaticCompactionTarget | undefined {
    if (key.kind !== 'child') return undefined;
    const parent = this.parents.get(key.parentAppSessionId);
    const child = parent?.children.get(key.childSessionId);
    if (!parent || !child?.runtime) return undefined;
    const target = this.automaticTarget(parent, child);
    return matchesChildGenerationSnapshot(target, key) ? target : undefined;
  }

  settleAutomatic(settlement: AutoCompactionSettlement): void {
    if (settlement.kind !== 'child') return;
    const parent = this.parents.get(settlement.parentAppSessionId);
    const child = parent?.children.get(settlement.childSessionId);
    if (!parent || !child?.runtime || !this.isCurrentChild(parent, child)) return;
    const target = this.automaticTarget(parent, child);
    if (!matchesChildGenerationSnapshot(target, settlement)) return;
    if (child.closeWhenIdle) {
      void this.close(child.identity);
      return;
    }
    const next = child.turn.pendingSends.shift();
    if (next !== undefined) {
      void this.drive(parent, child, next);
      return;
    }
    child.status = 'paused';
    this.commit(child);
    if (parent.runtimeQueue.length > 0) void this.closeRuntime(parent, child, true);
  }

  async close(identity: ChildIdentity): Promise<void> {
    const parent = this.parents.get(identity.parentAppSessionId);
    const child = parent?.children.get(identity.childSessionId);
    if (parent && child) {
      dequeueQueuedChild(parent, child);
      await this.closeRuntime(parent, child, true);
    }
  }

  async closeWhenIdle(identity: ChildIdentity): Promise<void> {
    const parent = this.parents.get(identity.parentAppSessionId);
    const child = parent?.children.get(identity.childSessionId);
    if (!parent || !child) return;
    child.closeWhenIdle = true;
    if (
      child.turn.phase === 'idle' &&
      !child.turn.autoCompacting &&
      child.turn.pendingSends.length === 0
    )
      await this.close(identity);
  }

  async closeParent(parentAppSessionId: string, deadline?: ShutdownDeadline): Promise<void> {
    const parent = this.parents.get(parentAppSessionId);
    if (!parent) return;
    parent.closing = true;
    parent.generation += 1;
    await cancelOpenAttempts(parent);
    for (const child of parent.children.values())
      await this.closeRuntime(parent, child, false, deadline);
    parent.pendingSpawns.clear();
    parent.reservedOpenSlots.clear();
    parent.runtimeQueue = [];
    const durabilityPrefix = `${parentAppSessionId}\u0000`;
    for (const key of this.childrenAwaitingDurability.keys()) {
      if (key.startsWith(durabilityPrefix)) this.childrenAwaitingDurability.delete(key);
    }
    if (this.parents.get(parentAppSessionId) === parent) this.parents.delete(parentAppSessionId);
  }

  async shutdown(deadline?: ShutdownDeadline): Promise<void> {
    this.shuttingDown = true;
    this.retirementTimer.cancel();
    const parents = [...this.parents.values()];
    for (const parent of parents) parent.closing = true;
    for (const parent of parents) await this.closeParent(parent.parentAppSessionId, deadline);
  }

  // Release the provider process behind every child that has been settled and
  // untouched past the idle budget. The child, its transcript, and its history
  // all survive; opening it again reloads the provider session.
  async retireIdleRuntimes(): Promise<void> {
    for (const { parent, child } of retirableChildRuntimes(
      this.parents.values(),
      this.d.now(),
      this.d.childRuntimeIdleMs,
      (candidate) => this.childrenAwaitingDurability.has(childDurabilityKey(candidate.identity)),
    )) {
      this.d.timeline.appendStatus(
        parent.parentAppSessionId,
        CHILD_RUNTIME_RETIRED_STATUS,
        undefined,
        child.identity.childSessionId,
        child.role,
      );
      await this.closeRuntime(parent, child, true);
    }
    this.armRetirement();
  }

  private armRetirement(): void {
    if (this.shuttingDown) {
      this.retirementTimer.cancel();
      return;
    }
    this.retirementTimer.armFor(
      nextChildRuntimeRetirementAt(this.parents.values(), this.d.childRuntimeIdleMs, (candidate) =>
        this.childrenAwaitingDurability.has(childDurabilityKey(candidate.identity)),
      ),
      this.d.now(),
    );
  }

  private async openFor(
    parentAppSessionId: string,
    childSessionId: string,
    requestId: string | null,
    operation: Exclude<ChildOperation, 'settings'>,
  ): Promise<void> {
    const identity = childIdentity(parentAppSessionId, childSessionId);
    const liveParent = this.d.registry.getLive(parentAppSessionId);
    if (liveParent?.closeMode) return;
    const record = this.d.childPersistence.get(parentAppSessionId, childSessionId);
    if (!record) {
      this.emitError(
        identity,
        operation,
        requestId,
        'child.not_in_session',
        `Child session ${childSessionId} is not tied to session ${parentAppSessionId}.`,
      );
      return;
    }
    const parent = this.parents.get(parentAppSessionId);
    if (!parent || record.status === 'completed') {
      openChildHistory(record, operation, requestId, {
        emitError: (identity, op, id, code, message) => {
          this.emitError(identity, op, id, code, message);
        },
        emit: (event) => {
          this.d.emit(event);
        },
        loadChildHistory: (query) => {
          this.d.timeline.loadChildHistory(query);
        },
      });
      return;
    }
    let child = parent.children.get(childSessionId);
    if (!child) {
      child = childStateFromRecord(record);
      parent.children.set(childSessionId, child);
    }
    if (!this.isCurrentParent(parent)) return;
    requireDroidCapability(parent.lease, 'addressableChildren', `child.${operation}`);
    if (child.mutationTail) {
      await child.mutationTail;
      if (!this.isCurrentParent(parent)) return;
    }
    if (child.runtime) {
      child.runtime.lastUsedAt = this.d.now();
      if (requestId) this.emitReady(child.runtime, child, requestId);
      return;
    }
    if (child.queued) {
      if (requestId) child.queuedRequestId = requestId;
      this.publish(child);
      return;
    }
    const existing = parent.openAttempts.get(childSessionId);
    if (existing) {
      await existing.settled;
      if (!this.isCurrentParent(parent)) return;
      const opened = parent.children.get(childSessionId)?.runtime;
      if (opened && requestId) this.emitReady(opened, child, requestId);
      else if (!opened)
        this.emitError(
          identity,
          operation,
          requestId,
          'child.open_failed',
          'The child runtime did not become available.',
        );
      return;
    }
    if (!child.providerSessionId) {
      this.emitError(
        identity,
        operation,
        requestId,
        'child.runtime_unavailable',
        'The child session has no current provider runtime.',
      );
      return;
    }

    await installChildRuntime({
      parent,
      child,
      identity,
      requestId,
      operation,
      host: this.runtimeOpenHost(),
    });
  }

  private runtimeOpenHost(): ChildRuntimeInstallHost {
    return {
      d: this.d,
      isCurrentParent: (parent) => this.isCurrentParent(parent),
      isCurrentChild: (parent, child) => this.isCurrentChild(parent, child),
      isCurrentRuntime: (parent, child, runtime) => this.isCurrentRuntime(parent, child, runtime),
      reserveCapacity: (parent, child, operation, requestId) =>
        this.reserveCapacity(parent, child, operation, requestId),
      emitReady: (runtime, child, requestId) => {
        this.emitReady(runtime, child, requestId);
      },
      emitError: (identity, operation, requestId, code, message) => {
        this.emitError(identity, operation, requestId, code, message);
      },
      persist: (child) => this.persist(child),
      publish: (child) => {
        this.publish(child);
      },
      drive: (parent, child, text) => this.drive(parent, child, text),
      closeRuntime: (parent, child, publish) => this.closeRuntime(parent, child, publish),
      admitNextQueued: (parent) => {
        this.admitNextQueued(parent);
      },
      automaticTarget: (parent, child) => this.automaticTarget(parent, child),
      contextTarget: (parent, child, runtime) => this.contextTarget(parent, child, runtime),
      onOpenAttemptFinished: () => {
        this.armRetirement();
      },
    };
  }

  private async requireRuntime(
    identity: ChildIdentity,
    operation: 'send' | 'sendNow' | 'interrupt',
  ): Promise<ChildRuntimeTarget | undefined> {
    const parent = this.parents.get(identity.parentAppSessionId);
    const child = parent?.children.get(identity.childSessionId);
    if (!parent || !child) {
      this.emitError(
        identity,
        operation,
        null,
        'child.not_in_session',
        `Child session ${identity.childSessionId} is not tied to session ${identity.parentAppSessionId}.`,
      );
      return undefined;
    }
    if (!child.runtime)
      await this.openFor(identity.parentAppSessionId, identity.childSessionId, null, operation);
    const runtime = child.runtime;
    if (!childAcceptsWork(child)) return undefined;
    return this.isCurrentChild(parent, child) && runtime ? { parent, child, runtime } : undefined;
  }

  private async drive(
    parent: ParentChildSessions,
    child: ChildSessionState,
    text: string,
  ): Promise<void> {
    const runtime = child.runtime;
    if (!runtime || !this.isCurrentRuntime(parent, child, runtime)) return;
    if (child.turn.autoCompacting) this.d.compaction.cancel(this.automaticTarget(parent, child));
    const turnGeneration = ++child.turn.generation;
    child.turn.phase = 'streaming';
    runtime.lastUsedAt = this.d.now();
    child.status = 'running';
    try {
      this.d.eventFlow.beginTurn(parent.parentAppSessionId, runtime.session.sessionId);
      const tokenStream = childTokenStream();
      child.streamFidelity = tokenStream.fidelity;
      this.commit(child);
      this.d.context.startPolling(this.contextTarget(parent, child, runtime));
      for await (const event of runtime.session.stream(text, tokenStream.options)) {
        if (!this.isCurrentTurn(parent, child, runtime, turnGeneration)) break;
        this.d.eventFlow.applyStreamEvent(
          parent.parentAppSessionId,
          runtime.session.sessionId,
          child.role,
          event,
          child.identity.childSessionId,
        );
      }
    } catch (error) {
      if (!this.isCurrentRuntime(parent, child, runtime)) return;
      if (child.turn.interruptingForSteer)
        this.d.timeline.appendStatus(
          parent.parentAppSessionId,
          'Child-session turn interrupted for steering.',
          undefined,
          child.identity.childSessionId,
          child.role,
        );
      else if (!(child.turn.interrupting && isUserCancellation(error))) {
        this.flushStreaming(child.identity);
        this.emitError(child.identity, 'send', null, 'child.send_failed', errMsg(error));
      }
    } finally {
      await this.settleTurn(parent, child, runtime, turnGeneration);
    }
  }

  private async settleTurn(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
    turnGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentTurn(parent, child, runtime, turnGeneration)) return;
    // Deliver only this runtime generation's buffered tail before it reads as
    // settled. A retired turn must not settle its replacement's shared source.
    this.settleStreaming(child.identity);
    this.d.context.stopPolling(this.contextTarget(parent, child, runtime));
    child.turn.interruptingForSteer = false;
    child.turn.interrupting = false;
    if (child.closeWhenIdle && !child.turn.autoCompacting) {
      child.turn.phase = 'idle';
      await this.closeRuntime(parent, child, true);
      return;
    }
    await this.d.context.refresh(this.contextTarget(parent, child, runtime));
    if (!this.isCurrentTurn(parent, child, runtime, turnGeneration)) return;
    child.turn.phase = 'idle';
    if (child.turn.autoCompacting) {
      this.d.compaction.afterTurn(this.automaticTarget(parent, child));
      return;
    }
    const next = child.turn.pendingSends.shift();
    if (next !== undefined) {
      void this.drive(parent, child, next);
      return;
    }
    child.status = 'paused';
    this.commit(child);
    if (parent.runtimeQueue.length > 0) await this.closeRuntime(parent, child, true);
  }

  private flushStreaming(identity: ChildIdentity): void {
    try {
      this.d.timeline.flushStreamingFor(identity.parentAppSessionId, identity.childSessionId);
    } catch (error) {
      this.reportStreamingPersistenceFailure(identity, error);
    }
  }

  private settleStreaming(identity: ChildIdentity): void {
    try {
      this.d.timeline.settleStreaming(identity.parentAppSessionId, identity.childSessionId);
    } catch (error) {
      this.reportStreamingPersistenceFailure(identity, error);
    }
  }

  private reportStreamingPersistenceFailure(identity: ChildIdentity, error: unknown): void {
    if (isReportedStreamingTranscriptError(error)) return;
    this.emitError(
      identity,
      'send',
      null,
      'child.transcript_persist_failed',
      `Unable to persist buffered child output: ${errMsg(error)}`,
    );
  }

  private async performSettingsUpdate(
    target: ChildSettingsTarget,
    command: ChildSettingsCommand,
  ): Promise<void> {
    if (!this.isSettingsTransaction(target)) return;
    const { parent, child, runtime } = target;
    target.configurationGeneration = child.configurationGeneration;
    let modelId = command.modelId ?? undefined;
    try {
      if (command.modelId === null)
        modelId = this.d.resolveDefaultSettings(
          parent.lease.summary,
          parent.lease.session.initResult ?? {},
          child.role,
        ).modelId;
      if (!modelId) throw new Error(`No Factory default is available for ${child.role}.`);
      if (!this.isSettingsTransaction(target)) return;
      await runtime.droid.updateSettings({
        modelId,
        ...(command.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: factoryReasoningEffort(command.reasoningEffort) }),
      });
    } catch (error) {
      if (this.isSettingsTransaction(target))
        this.emitError(
          child.identity,
          'settings',
          null,
          'child.settings_update_failed',
          `Could not update child settings: ${errMsg(error)}`,
        );
      return;
    }
    if (!this.isSettingsTransaction(target)) return;
    if (child.turn.autoCompacting) this.d.compaction.cancel(this.automaticTarget(parent, child));
    child.modelId = modelId;
    if (command.reasoningEffort !== undefined) child.reasoningEffort = command.reasoningEffort;
    child.configurationGeneration += 1;
    this.commit(child);
    try {
      await this.d.compaction.rearmModelChangedChild(
        this.compactionTarget(parent, child, modelId),
        modelId,
      );
    } catch (error) {
      console.error(
        `[compaction] could not resolve exact-child limit for ${runtime.session.sessionId}: ${errMsg(error)}`,
      );
    }
  }

  private complete(parent: ParentChildSessions, child?: ChildSessionState): void {
    if (!child || child.status === 'completed') return;
    child.status = 'completed';
    // Activity describes a moment that has passed; keeping the last poll's line
    // would leave a finished subagent reading as still working.
    child.activity = undefined;
    if (this.commit(child)) void this.closeWhenIdle(child.identity);
    else {
      const pending = this.childrenAwaitingDurability.get(childDurabilityKey(child.identity));
      if (pending) pending.closeAfterPublish = true;
    }
  }

  private createChild(
    parent: ParentChildSessions,
    role: PersistedChildSession['role'],
    spawnLink?: PersistedChildSpawnLink,
    launchSettings: ChildSettings = {},
    exactLaunchSettings = false,
  ): ChildSessionState {
    const settings = exactLaunchSettings
      ? launchSettings
      : {
          ...this.d.resolveDefaultSettings(
            parent.lease.summary,
            parent.lease.session.initResult ?? {},
            role,
          ),
          ...launchSettings,
        };
    if (!settings.modelId) throw new Error(`No accepted model is available for ${role}.`);
    const child = newChildState({
      parentAppSessionId: parent.parentAppSessionId,
      childSessionId: this.d.nextChildSessionId(),
      role,
      spawnLink,
      modelId: settings.modelId,
      reasoningEffort: settings.reasoningEffort,
      updatedAt: this.d.now(),
    });
    parent.children.set(child.identity.childSessionId, child);
    return child;
  }

  private readLaunchSettings(providerSessionId: string): ChildSettings | undefined {
    try {
      return this.d.readLaunchSettings(providerSessionId);
    } catch (error) {
      console.error(
        `Could not read Task launch settings for ${providerSessionId}: ${errMsg(error)}`,
      );
      return undefined;
    }
  }

  private async reserveCapacity(
    parent: ParentChildSessions,
    requested: ChildSessionState,
    operation: Exclude<ChildOperation, 'settings'>,
    requestId: string | null,
  ): Promise<boolean | 'queued'> {
    const limits = childRuntimeLimits(this.d);
    const decision = decideChildRuntimeCapacity(parent, requested, limits);
    if (decision.action === 'reserve' || decision.action === 'evict') {
      parent.reservedOpenSlots.add(requested.identity.childSessionId);
      if (decision.action === 'evict') await this.closeRuntime(parent, decision.victim, true);
      return true;
    }
    if (decision.action === 'queue') {
      enqueueChildRuntime(parent, requested, requestId);
      this.publish(requested);
      return 'queued';
    }
    this.emitError(
      requested.identity,
      operation,
      requestId,
      'child.open_failed',
      `Open child-session limit reached (${String(this.d.maxOpenSessions)}). Wait for one running child view to finish before opening another.`,
    );
    return false;
  }

  private admitNextQueued(parent: ParentChildSessions): void {
    if (!this.isCurrentParent(parent) || parent.closing) return;
    const next = takeNextQueuedChild(parent, childRuntimeLimits(this.d).maxLive);
    if (!next) return;
    this.publish(next.child);
    void this.openFor(
      parent.parentAppSessionId,
      next.child.identity.childSessionId,
      next.requestId,
      'open',
    );
  }

  private async closeRuntime(
    parent: ParentChildSessions,
    child: ChildSessionState,
    publish: boolean,
    deadline?: ShutdownDeadline,
  ): Promise<void> {
    const runtime = child.runtime;
    if (!runtime) return child.mutationTail;
    try {
      this.d.compaction.cancel(this.automaticTarget(parent, child));
    } catch {
      // Cleanup remains authoritative even when cancellation cannot resolve its target.
    }
    this.d.compaction.forgetChild(child.identity);
    child.runtime = undefined;
    // The confirmed autonomy belonged to the closed runtime; a later open
    // re-reads it from the new provider session's init result.
    child.autonomy = undefined;
    const closedGeneration = (child.runtimeGeneration =
      Math.max(child.runtimeGeneration, runtime.generation) + 1);
    child.turn.generation += 1;
    child.turn.phase = 'idle';
    child.turn.autoCompacting = false;
    child.turn.pendingSends = [];
    child.turn.interruptingForSteer = false;
    child.turn.interrupting = false;
    const cleanupTarget = this.contextTarget(parent, child, runtime);
    void runCleanup(this.d.context.forgetChild.bind(this.d.context, child.identity));
    void runCleanup(this.d.context.stopPolling.bind(this.d.context, cleanupTarget));
    const closeSession = () =>
      (runtime.session.close as (closeDeadline?: ShutdownDeadline) => Promise<void>)(deadline);
    const cleanupTasks = [runtime.unsubscribe ?? ignoreError, closeSession];
    const cleanup = (child.mutationTail ?? Promise.resolve())
      .catch(ignoreError)
      .then(() => Promise.allSettled(cleanupTasks.map(runCleanup)))
      .then(ignoreError);
    child.mutationTail = cleanup;
    await (deadline ? deadline.awaitSettled(cleanup) : cleanup);
    this.clearMutation(child, cleanup);
    if (
      publish &&
      this.isCurrentParent(parent) &&
      child.runtimeGeneration === closedGeneration &&
      !this.childrenAwaitingDurability.has(childDurabilityKey(child.identity))
    )
      this.publish(child);
    this.admitNextQueued(parent);
  }

  private contextTarget(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
  ) {
    return childContextTarget(parent, child, runtime, () =>
      this.isCurrentRuntime(parent, child, runtime),
    );
  }

  private automaticTarget(
    parent: ParentChildSessions,
    child: ChildSessionState,
  ): ChildAutomaticCompactionTarget {
    const runtime = child.runtime;
    if (!runtime) throw new Error(`Child ${child.identity.childSessionId} has no live runtime.`);
    const parentGeneration = parent.generation;
    const turnGeneration = child.turn.generation;
    const configurationGeneration = child.configurationGeneration;
    const isCaptured = () =>
      parent.generation === parentGeneration &&
      this.isCurrentRuntime(parent, child, runtime) &&
      child.turn.generation === turnGeneration &&
      child.configurationGeneration === configurationGeneration;
    return {
      ...this.contextTarget(parent, child, runtime),
      kind: 'child',
      parentGeneration,
      runtimeGeneration: runtime.generation,
      turnGeneration,
      configurationGeneration,
      isAutoCompacting: () => isCaptured() && child.turn.autoCompacting,
      setAutoCompacting: (active) => {
        if (isCaptured()) child.turn.autoCompacting = active;
      },
      isStreaming: () => isCaptured() && child.turn.phase === 'streaming',
      isCurrent: isCaptured,
    };
  }

  private compactionTarget(
    parent: ParentChildSessions,
    child: ChildSessionState,
    modelId: string,
  ): ChildCompactionTarget {
    const target = this.automaticTarget(parent, child);
    const configurationGeneration = child.configurationGeneration;
    return {
      ...target,
      effectiveModelId: modelId,
      isCurrent: () =>
        target.isCurrent() &&
        this.isSettingsTarget(parent, child) &&
        child.configurationGeneration === configurationGeneration &&
        child.modelId === modelId,
    };
  }

  private isCurrentParent(parent: ParentChildSessions): boolean {
    return (
      !this.shuttingDown &&
      !this.d.isShutdownStarted() &&
      !parent.closing &&
      !parent.lease.closeMode &&
      this.parents.get(parent.parentAppSessionId) === parent &&
      this.d.registry.getLive(parent.parentAppSessionId) === parent.lease
    );
  }

  private isCurrentChild(parent: ParentChildSessions, child: ChildSessionState): boolean {
    return (
      this.isCurrentParent(parent) && parent.children.get(child.identity.childSessionId) === child
    );
  }

  private isCurrentRuntime(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
  ): boolean {
    return this.isCurrentChild(parent, child) && child.runtime === runtime;
  }

  private isCurrentTurn(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
    generation: number,
  ): boolean {
    return (
      this.isCurrentTurnGeneration(parent, child, runtime, generation) &&
      child.turn.phase === 'streaming'
    );
  }

  private isCurrentTurnGeneration(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
    generation: number,
  ): boolean {
    return this.isCurrentRuntime(parent, child, runtime) && child.turn.generation === generation;
  }

  private isSettingsTarget(parent: ParentChildSessions, child: ChildSessionState): boolean {
    return (
      this.isCurrentChild(parent, child) &&
      child.runtime !== undefined &&
      child.status !== 'completed' &&
      !child.closeWhenIdle
    );
  }

  private isSettingsTransaction(target: ChildSettingsTarget): boolean {
    const { parent, child, runtime } = target;
    return (
      parent.generation === target.parentGeneration &&
      runtime.generation === target.runtimeGeneration &&
      this.isSettingsTarget(parent, child) &&
      child.runtime === runtime &&
      (target.configurationGeneration === undefined ||
        child.configurationGeneration === target.configurationGeneration)
    );
  }

  private emitReady(runtime: ChildRuntimeState, child: ChildSessionState, id: string): void {
    this.d.emit({
      type: 'child.updated',
      ...child.identity,
      requestId: id,
      access: 'ready',
      runtimeGeneration: runtime.generation,
    });
  }

  private emitError(
    identity: ChildIdentity,
    operation: ChildOperation,
    requestId: string | null,
    code: string,
    message: string,
  ): void {
    this.d.emit({
      type: 'child.error',
      ...identity,
      operation,
      requestId,
      code,
      message,
      recoverable: true,
    });
  }

  private persist(child: ChildSessionState): boolean | undefined {
    const parent = this.parents.get(child.identity.parentAppSessionId);
    if (!parent) {
      throw new Error(
        `Cannot persist child ${child.identity.childSessionId} without attached parent ${child.identity.parentAppSessionId}.`,
      );
    }
    return this.d.childPersistence.upsert(
      {
        ...persistedChild(child),
        updatedAt: this.d.now(),
      },
      parent.lease.binding,
    );
  }

  private commit(child: ChildSessionState): boolean {
    const key = childDurabilityKey(child.identity);
    const durable = this.persist(child);
    if (durable === false) {
      const previous = this.childrenAwaitingDurability.get(key);
      this.childrenAwaitingDurability.set(key, {
        child,
        closeAfterPublish: previous?.closeAfterPublish ?? false,
      });
      return false;
    }
    const pending = this.childrenAwaitingDurability.get(key);
    this.childrenAwaitingDurability.delete(key);
    this.publish(child);
    if (pending?.closeAfterPublish) void this.closeWhenIdle(child.identity);
    return true;
  }

  private clearMutation(child: ChildSessionState, mutation: Promise<void>): boolean {
    return child.mutationTail === mutation && delete child.mutationTail;
  }

  private publish(child: ChildSessionState): void {
    this.armRetirement();
    this.d.emit({
      type: 'session.child',
      event: 'upserted',
      child: childSummary(child),
      runtimeAvailable: child.runtime !== undefined,
      runtimeGeneration: child.runtime?.generation ?? child.runtimeGeneration,
    });
  }
}

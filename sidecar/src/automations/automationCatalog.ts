import {
  assertModelSelection,
  createAutomationRecord,
  normalizeAutomationInput,
} from './automationInput.js';
import { nextRunAfterUpdate } from './automationScheduler.js';
import type { AutomationSessionContext } from './sessionContexts.js';
import type {
  Automation,
  AutomationInput,
  AutomationPatch,
  AutomationReasoningEffort,
  AutomationRun,
  AutomationStore,
} from './types.js';

/**
 * What changing or removing a definition does to the runs that reference it.
 * Runs stay owned by the run queue; the catalog only says when they no longer
 * belong to a schedule.
 */
interface AutomationRunCascade {
  capture: () => AutomationRun[];
  restore: (runs: AutomationRun[]) => void;
  dropQueuedSchedules: (automationId: string) => void;
  dropAllFor: (automationId: string) => void;
}

export interface AutomationCatalogOptions {
  /** Read through a getter: the manager replaces the store once, on load. */
  store: () => AutomationStore;
  now: () => number;
  /** Applies a store mutation and undoes it when the write fails. */
  commit: (apply: () => void, undo: () => void) => Promise<void>;
  /** Rejects a model and reasoning pair DROIDEX cannot run. */
  validateSelection: (modelId: string, reasoningEffort: AutomationReasoningEffort) => Promise<void>;
  /** Settings an automation inherits from the chat that asked for it. */
  sessionContext: (appSessionId: string) => Promise<AutomationSessionContext | null>;
  runs: AutomationRunCascade;
}

/**
 * Owns `store.automations`: the definitions the user configured.
 *
 * Every field of a definition is validated here before it is stored, and a
 * change that moves an automation's schedule takes the queued runs of the old
 * schedule with it. The scheduler decides when an automation runs next; this
 * asks it for that answer and records it in the same write.
 */
export class AutomationCatalog {
  constructor(private readonly options: AutomationCatalogOptions) {}

  find(id: string): Automation | undefined {
    return this.records.find((automation) => automation.id === id);
  }

  require(id: string): Automation {
    const automation = this.find(id);
    if (!automation) throw new Error('Automation not found.');
    return automation;
  }

  /** Records a validated definition. Newest first, the order the UI lists. */
  add(automation: Automation): void {
    this.records.unshift(automation);
  }

  /** Removes a definition and the runs that referenced it. */
  discard(id: string): void {
    this.options.store().automations = this.records.filter((automation) => automation.id !== id);
    this.options.runs.dropAllFor(id);
  }

  /** The definitions as they stand, for a caller that has to undo a delete. */
  capture(): Automation[] {
    return this.records;
  }

  restore(automations: Automation[]): void {
    this.options.store().automations = automations;
  }

  async create(input: AutomationInput): Promise<Automation> {
    const normalized = normalizeAutomationInput(input);
    assertModelSelection(normalized);
    await this.options.validateSelection(normalized.modelId, normalized.reasoningEffort);
    const automation = createAutomationRecord(normalized, this.options.now());
    await this.options.commit(
      () => {
        this.add(automation);
      },
      () => {
        this.discard(automation.id);
      },
    );
    return structuredClone(automation);
  }

  /**
   * Creates an automation on behalf of a chat, inheriting the settings the
   * caller left out. Only a High autonomy chat may skip the user's review.
   */
  async createFromSession(input: AutomationInput, sourceAppSessionId: string): Promise<Automation> {
    const context = await this.options.sessionContext(sourceAppSessionId);
    if (context?.autonomy !== 'high') {
      throw new Error(
        'Direct automation creation requires High autonomy. Use automation_propose so the user can review and confirm the DROIDEX card.',
      );
    }
    return this.create({
      ...input,
      workspaceCwd: input.workspaceCwd === undefined ? context.cwd : input.workspaceCwd,
      executionMode: input.executionMode ?? 'local',
      timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      modelId: input.modelId === undefined ? context.modelId : input.modelId,
      reasoningEffort:
        input.reasoningEffort === undefined ? context.reasoningEffort : input.reasoningEffort,
      autonomy: input.autonomy ?? context.autonomy,
    });
  }

  async update(id: string, patch: AutomationPatch): Promise<Automation> {
    const current = this.require(id);
    const normalized = normalizeAutomationInput({
      title: patch.title ?? current.title,
      prompt: patch.prompt ?? current.prompt,
      workspaceCwd: patch.workspaceCwd === undefined ? current.workspaceCwd : patch.workspaceCwd,
      executionMode: patch.executionMode ?? current.executionMode,
      enabled: patch.enabled ?? current.enabled,
      schedule: patch.schedule ?? current.schedule,
      timezone: patch.timezone ?? current.timezone,
      modelId: patch.modelId === undefined ? current.modelId : patch.modelId,
      reasoningEffort:
        patch.reasoningEffort === undefined ? current.reasoningEffort : patch.reasoningEffort,
      autonomy: patch.autonomy ?? current.autonomy,
    });
    if (normalized.enabled) {
      assertModelSelection(normalized);
      await this.options.validateSelection(normalized.modelId, normalized.reasoningEffort);
    }
    const now = this.options.now();
    const scheduleChanged = patch.schedule !== undefined || patch.timezone !== undefined;
    const enabledChanged = patch.enabled !== undefined;
    const next: Automation = {
      ...current,
      ...normalized,
      nextRunAt: nextRunAfterUpdate(current, normalized, scheduleChanged || enabledChanged, now),
      completedAt: normalized.enabled ? null : current.completedAt,
      updatedAt: now,
    };
    const previousRuns = this.options.runs.capture();
    await this.options.commit(
      () => {
        // A run queued for the old schedule is no longer what the user asked
        // for, and a disabled automation must not run at all.
        if (scheduleChanged || !normalized.enabled) this.options.runs.dropQueuedSchedules(id);
        this.replace(id, next);
      },
      () => {
        this.options.runs.restore(previousRuns);
        this.replace(id, current);
      },
    );
    return structuredClone(next);
  }

  private replace(id: string, record: Automation): void {
    const index = this.records.findIndex((automation) => automation.id === id);
    if (index < 0) throw new Error('Automation not found.');
    this.records[index] = record;
  }

  private get records(): Automation[] {
    return this.options.store().automations;
  }
}

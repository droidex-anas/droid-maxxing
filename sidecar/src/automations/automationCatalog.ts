import {
  assertEnabledScheduleHasNextRun,
  assertModelSelection,
  createAutomationRecord,
  normalizeAutomationInput,
} from './automationInput.js';
import { nextRunAfterUpdate } from './automationScheduler.js';
import { storeHasRunSession } from './automationStore.js';
import type { AutomationSessionContext } from './sessionContexts.js';
import type {
  Automation,
  AutomationInput,
  AutomationPatch,
  AutomationReasoningEffort,
  AutomationStore,
} from './types.js';

/**
 * What changing or removing a definition does to the runs that reference it.
 * Runs stay owned by the run queue; the catalog only says when they no longer
 * belong to a schedule.
 */
interface AutomationRunCascade {
  dropQueuedSchedules: (automationId: string) => void;
  dropAllFor: (automationId: string) => void;
}

export interface AutomationCatalogOptions {
  /** Read through a getter: the manager replaces the store once, on load. */
  store: () => AutomationStore;
  now: () => number;
  /** Serializes, persists, and publishes one store operation. */
  commit: <T>(apply: () => T | Promise<T>) => Promise<T>;
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

  async create(input: AutomationInput): Promise<Automation> {
    return this.options.commit(() => this.createRecord(input));
  }

  /**
   * Creates an automation on behalf of a chat, inheriting the settings the
   * caller left out. Only a High autonomy interactive chat may skip the user's
   * review; an unattended run cannot spawn another automation.
   */
  async createFromSession(input: AutomationInput, sourceAppSessionId: string): Promise<Automation> {
    return this.options.commit(async () => {
      if (storeHasRunSession(this.options.store(), sourceAppSessionId)) {
        throw new Error('Unattended automation runs cannot create DROIDEX automations.');
      }
      const context = await this.options.sessionContext(sourceAppSessionId);
      if (
        storeHasRunSession(this.options.store(), sourceAppSessionId) ||
        context?.autonomy !== 'high'
      ) {
        throw new Error(
          context?.autonomy === 'high'
            ? 'Unattended automation runs cannot create DROIDEX automations.'
            : 'Direct automation creation requires High autonomy. Use automation_propose so the user can review and confirm the DROIDEX card.',
        );
      }
      return this.createRecord({
        ...input,
        workspaceCwd: input.workspaceCwd === undefined ? context.cwd : input.workspaceCwd,
        executionMode: input.executionMode ?? 'local',
        timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        modelId: input.modelId === undefined ? context.modelId : input.modelId,
        reasoningEffort:
          input.reasoningEffort === undefined ? context.reasoningEffort : input.reasoningEffort,
        autonomy: input.autonomy ?? context.autonomy,
      });
    });
  }

  async update(id: string, patch: AutomationPatch): Promise<Automation> {
    return this.options.commit(async () => {
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
      if (scheduleChanged || enabledChanged) {
        assertEnabledScheduleHasNextRun(normalized, now);
      }
      const next: Automation = {
        ...current,
        ...normalized,
        nextRunAt: nextRunAfterUpdate(current, normalized, scheduleChanged || enabledChanged, now),
        completedAt: normalized.enabled ? null : current.completedAt,
        updatedAt: now,
      };
      if (scheduleChanged || !normalized.enabled) this.options.runs.dropQueuedSchedules(id);
      this.replace(id, next);
      return structuredClone(next);
    });
  }

  private async createRecord(input: AutomationInput): Promise<Automation> {
    const normalized = normalizeAutomationInput(input);
    assertModelSelection(normalized);
    await this.options.validateSelection(normalized.modelId, normalized.reasoningEffort);
    const automation = createAutomationRecord(normalized, this.options.now());
    this.add(automation);
    return structuredClone(automation);
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

import { randomUUID } from 'node:crypto';
import {
  assertEnabledScheduleHasNextRun,
  assertModelSelection,
  createAutomationRecord,
  missingProposalFields,
  normalizeAutomationInput,
} from './automationInput.js';
import type { AutomationSessionContext } from './sessionContexts.js';
import type {
  Automation,
  AutomationInput,
  AutomationProposal,
  AutomationReasoningEffort,
  AutomationStore,
} from './types.js';

/**
 * The automation records a confirmed proposal creates. Creation happens inside
 * the confirming write so the automation and the proposal's link to it can never
 * disagree; every later mutation of an automation belongs to AutomationManager.
 */
interface AutomationsCollection {
  find: (id: string) => Automation | undefined;
  add: (automation: Automation) => void;
  discard: (id: string) => void;
}

export interface AutomationProposalsOptions {
  /** Read through a getter: the manager replaces the store once, on load. */
  store: () => AutomationStore;
  now: () => number;
  /** Applies a store mutation and undoes it when the write fails. */
  commit: (apply: () => void, undo: () => void) => Promise<void>;
  /** Settings a proposal inherits from the chat that asked for it. */
  sessionContext: (appSessionId: string) => Promise<AutomationSessionContext | null>;
  /** Rejects a model and reasoning pair DROIDEX cannot run. */
  validateSelection: (modelId: string, reasoningEffort: AutomationReasoningEffort) => Promise<void>;
  automations: AutomationsCollection;
}

/**
 * Owns `store.proposals`. Confirming writes the automation and the proposal's
 * link to it in one commit. Deleting that automation returns the proposal to a
 * draft so a card in an old chat never links to something missing.
 */
export class AutomationProposals {
  private readonly confirmOperations = new Map<string, Promise<Automation>>();

  constructor(private readonly options: AutomationProposalsOptions) {}

  /** Records a draft for review, inheriting whatever the caller left out. */
  async propose(input: AutomationInput, sourceAppSessionId: string): Promise<AutomationProposal> {
    const context = await this.options.sessionContext(sourceAppSessionId);
    const draft = normalizeAutomationInput({
      ...input,
      workspaceCwd: input.workspaceCwd === undefined ? (context?.cwd ?? null) : input.workspaceCwd,
      executionMode: input.executionMode ?? 'local',
      timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      modelId: input.modelId === undefined ? (context?.modelId ?? null) : input.modelId,
      reasoningEffort:
        input.reasoningEffort === undefined
          ? (context?.reasoningEffort ?? null)
          : input.reasoningEffort,
      autonomy: input.autonomy ?? context?.autonomy,
    });
    const now = this.options.now();
    assertEnabledScheduleHasNextRun(draft, now);
    const proposal: AutomationProposal = {
      id: randomUUID(),
      sourceAppSessionId,
      draft,
      status: 'draft',
      missingFields: missingProposalFields(draft),
      automationId: null,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
    };
    await this.options.commit(
      () => {
        this.store.proposals.unshift(proposal);
      },
      () => {
        this.store.proposals = this.store.proposals.filter(
          (candidate) => candidate.id !== proposal.id,
        );
      },
    );
    return structuredClone(proposal);
  }

  /**
   * Confirms a proposal and returns the automation it created. Concurrent
   * confirmations of the same proposal share one operation, so a double click on
   * the card cannot create the automation twice.
   */
  async confirm(id: string, input?: AutomationInput): Promise<Automation> {
    const pending = this.confirmOperations.get(id);
    if (pending) return pending;
    const operation = this.confirmOnce(id, input).finally(() => {
      if (this.confirmOperations.get(id) === operation) this.confirmOperations.delete(id);
    });
    this.confirmOperations.set(id, operation);
    return operation;
  }

  /** Clones the proposals of an automation so a failed delete can restore them. */
  capturedForAutomation(automationId: string): AutomationProposal[] {
    return this.store.proposals
      .filter((proposal) => proposal.automationId === automationId)
      .map((proposal) => structuredClone(proposal));
  }

  /**
   * Returns the proposals of a deleted automation to drafts, the same repair the
   * store applies on load, so a card never links to a missing automation.
   */
  unlinkAutomation(automationId: string, now: number): void {
    for (const proposal of this.store.proposals) {
      if (proposal.automationId !== automationId) continue;
      proposal.status = 'draft';
      proposal.missingFields = missingProposalFields(proposal.draft);
      proposal.automationId = null;
      proposal.confirmedAt = null;
      proposal.updatedAt = now;
    }
  }

  restore(captured: readonly AutomationProposal[]): void {
    for (const snapshot of captured) {
      const proposal = this.store.proposals.find((candidate) => candidate.id === snapshot.id);
      if (proposal) Object.assign(proposal, snapshot);
    }
  }

  private async confirmOnce(id: string, input?: AutomationInput): Promise<Automation> {
    const proposal = this.require(id);
    if (proposal.status === 'confirmed' && proposal.automationId) {
      return structuredClone(this.requireAutomation(proposal.automationId));
    }
    const draft = normalizeAutomationInput(input ?? proposal.draft);
    assertModelSelection(draft);
    await this.options.validateSelection(draft.modelId, draft.reasoningEffort);
    const now = this.options.now();
    const automation = createAutomationRecord(draft, now);
    const restored = structuredClone(proposal);
    await this.options.commit(
      () => {
        this.options.automations.add(automation);
        proposal.draft = draft;
        proposal.status = 'confirmed';
        proposal.missingFields = [];
        proposal.automationId = automation.id;
        proposal.confirmedAt = now;
        proposal.updatedAt = now;
      },
      () => {
        this.options.automations.discard(automation.id);
        Object.assign(proposal, restored);
      },
    );
    return structuredClone(automation);
  }

  private require(id: string): AutomationProposal {
    const proposal = this.store.proposals.find((candidate) => candidate.id === id);
    if (!proposal) throw new Error('Automation proposal not found.');
    return proposal;
  }

  private requireAutomation(id: string): Automation {
    const automation = this.options.automations.find(id);
    if (!automation) throw new Error('Automation not found.');
    return automation;
  }

  private get store(): AutomationStore {
    return this.options.store();
  }
}

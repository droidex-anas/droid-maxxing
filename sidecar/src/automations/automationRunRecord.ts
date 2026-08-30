import { randomUUID } from 'node:crypto';
import type { ClientCommand } from '../protocol.js';
import { assertModelSelection, isReasoningEffort } from './automationInput.js';
import { isActiveRunStatus } from './automationStore.js';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  AutomationStore,
  AutomationTrigger,
} from './types.js';
import type { ReleasableAutomationWorkspace } from './workspace.js';

export type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

/**
 * What a run record is: the definition it froze at queue time, the chat command
 * it launches, the audit of what that chat actually ran with, and the summary it
 * leaves on its automation.
 *
 * Everything here works on records that were handed in. Which run exists, when
 * it starts, and when it settles belongs to `AutomationRuns`.
 */

/**
 * Freezes the definition a run will use. A later edit to the automation does not
 * change a run that was already queued, so the run keeps the instructions the
 * user scheduled.
 */
export function newQueuedRun(
  automation: Automation,
  scheduledAt: number,
  requestedAt: number,
  trigger: AutomationTrigger,
): AutomationRun {
  return {
    id: randomUUID(),
    automationId: automation.id,
    automation: {
      id: automation.id,
      title: automation.title,
      prompt: automation.prompt,
      workspaceCwd: automation.workspaceCwd,
      executionMode: automation.executionMode,
      timezone: automation.timezone,
      modelId: automation.modelId,
      reasoningEffort: automation.reasoningEffort,
    },
    scheduledAt,
    requestedAt,
    trigger,
    status: 'queued',
    startedAt: null,
    finishedAt: null,
    clientRef: null,
    appSessionId: null,
    resolvedCwd: null,
    error: null,
    effectiveModelId: null,
    effectiveReasoningEffort: null,
    selectionVerified: null,
  };
}

/**
 * The chat a run needs: an automatic session at low autonomy, so it works
 * through its instructions without waiting for a person to approve each step.
 */
export function sessionCommandForRun(run: AutomationRun): SessionCreateCommand {
  if (!run.clientRef) throw new Error('Automation run is missing its session reference.');
  assertModelSelection(run.automation);
  return {
    type: 'session.create',
    clientRef: run.clientRef,
    ...(run.resolvedCwd ? { cwd: run.resolvedCwd } : {}),
    title: run.automation.title,
    goal: run.automation.prompt,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    modelId: run.automation.modelId,
    reasoningEffort: run.automation.reasoningEffort,
    autonomy: 'low',
  };
}

/**
 * Records the model and reasoning level the chat reports, and returns why the run
 * should fail when they are not the ones the automation selected. An automation
 * that silently ran on a different model produced work the user did not ask for.
 */
export function auditRunSelection(
  run: AutomationRun,
  session: { modelId?: string; reasoningEffort?: unknown },
): string | null {
  if (typeof session.modelId === 'string' && session.modelId.trim()) {
    run.effectiveModelId = session.modelId;
  }
  if (isReasoningEffort(session.reasoningEffort) && session.reasoningEffort !== null) {
    run.effectiveReasoningEffort = session.reasoningEffort;
  }
  if (!run.effectiveModelId || !run.effectiveReasoningEffort) return null;
  run.selectionVerified =
    run.effectiveModelId === run.automation.modelId &&
    run.effectiveReasoningEffort === run.automation.reasoningEffort;
  if (run.selectionVerified) return null;
  return `DROIDEX started this automation with ${run.effectiveModelId} · ${run.effectiveReasoningEffort} instead of the selected ${run.automation.modelId ?? 'model'} · ${run.automation.reasoningEffort ?? 'reasoning'}.`;
}

/**
 * The automation summary while a run is on its way to finishing. A run that has
 * not reached a chat yet leaves the previous run's chat link in place, so the
 * Automations screen keeps offering the last transcript there is.
 */
export function projectActiveRun(
  automation: Automation,
  run: AutomationRun,
  status: Extract<AutomationRunStatus, 'starting' | 'running'>,
  at: number,
): void {
  automation.lastRunAt = run.startedAt ?? at;
  automation.lastRunStatus = status;
  automation.lastRunError = null;
  automation.lastRunDurationMs = null;
  if (run.appSessionId) automation.lastAppSessionId = run.appSessionId;
  automation.updatedAt = at;
}

/**
 * Copies a settled run onto the automation summary the Automations screen reads,
 * so the list never disagrees with the run history below it.
 */
export function projectSettledRun(
  automation: Automation,
  run: AutomationRun,
  finishedAt: number,
): void {
  automation.lastRunAt = run.startedAt ?? finishedAt;
  automation.lastRunStatus = run.status;
  automation.lastRunError = run.error;
  automation.lastRunDurationMs =
    run.startedAt === null ? null : Math.max(0, finishedAt - run.startedAt);
  automation.lastAppSessionId = run.appSessionId;
  automation.updatedAt = finishedAt;
}

/** The chats and worktrees an interrupted run left for someone else to clean up. */
export interface InterruptedRunCleanup {
  appSessionIds: string[];
  workspaces: ReleasableAutomationWorkspace[];
}

/**
 * Fails the runs a previous process left in flight, so the queue starts clean,
 * and reports what they left running. Their chats and isolated worktrees need the
 * bridge and the file system, which the synchronous load cannot wait for.
 */
export function failInterruptedRuns(store: AutomationStore, now: number): InterruptedRunCleanup {
  const cleanup: InterruptedRunCleanup = { appSessionIds: [], workspaces: [] };
  for (const run of store.runs) {
    if (!isActiveRunStatus(run.status)) continue;
    run.status = 'failed';
    run.finishedAt = now;
    run.error = 'DROIDEX restarted before this automation run finished.';
    const automation = store.automations.find((candidate) => candidate.id === run.automationId);
    if (automation) projectSettledRun(automation, run, now);
    // The chat from the previous process is no longer tracked by any run, so it
    // must not keep streaming on its own.
    if (run.appSessionId) cleanup.appSessionIds.push(run.appSessionId);
    // Nothing will settle this run and release its isolated worktree, so the
    // recovery does it here. A worktree holding work is kept either way.
    if (run.resolvedCwd) {
      cleanup.workspaces.push({
        resolvedCwd: run.resolvedCwd,
        executionMode: run.automation.executionMode,
      });
    }
  }
  return cleanup;
}

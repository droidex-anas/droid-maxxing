import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  isReasoningEffort,
  missingProposalFields,
  normalizeAutomationInput,
} from './automationInput.js';
import { nextAutomationRun } from './schedule.js';
import type {
  Automation,
  AutomationInput,
  AutomationProposal,
  AutomationRun,
  AutomationRunStatus,
  AutomationSnapshot,
  AutomationStore,
} from './types.js';

/**
 * DROIDEX keeps one canonical store shape: a file written by another version is
 * quarantined rather than migrated (see the hard-cut policy in AGENTS.md).
 */
export const STORE_VERSION = 1;

// Retention is deliberately tight: the whole store is serialized on every state
// change and the snapshot is broadcast to every renderer, so history costs both
// disk writes and socket traffic.
const MAX_RUNS = 150;
const MAX_PROPOSALS = 50;
const MAX_ORIGINS = 200;
const SNAPSHOT_RUNS = 60;
const SNAPSHOT_PROPOSALS = 25;

export function emptyAutomationStore(): AutomationStore {
  return { version: STORE_VERSION, automations: [], runs: [], proposals: [], sessionOrigins: {} };
}

export function isActiveRunStatus(status: AutomationRunStatus): boolean {
  return status === 'starting' || status === 'running';
}

export function isSettledRunStatus(status: AutomationRunStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/** Owns the automations file: canonical shape on disk, atomic writes, recovery. */
export class AutomationStoreFile {
  private tail: Promise<void> = Promise.resolve();
  private pendingPayload: string | null = null;
  private pendingWrite: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  async read(now: number): Promise<AutomationStore> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return emptyAutomationStore();
      // Starting empty here would overwrite a store we simply could not read.
      throw error;
    }
    try {
      return parseAutomationStore(JSON.parse(text), now);
    } catch (error) {
      const quarantinePath = `${this.filePath}.unreadable-${String(now)}`;
      await rename(this.filePath, quarantinePath);
      throw new Error(
        `The DROIDEX automations file could not be read and was moved to ${quarantinePath}. Restart DROIDEX to start a new store, or restore that file after fixing it. Cause: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Serializes the current store. Writes are queued so they cannot interleave,
   * a queued write that has not started yet is superseded by the newer state,
   * and a failed write is reported to its caller without poisoning the queue.
   */
  write(store: AutomationStore): Promise<void> {
    this.pendingPayload = `${JSON.stringify(store)}\n`;
    if (this.pendingWrite) return this.pendingWrite;
    const write = this.tail.then(() => {
      const payload = this.pendingPayload;
      this.pendingPayload = null;
      this.pendingWrite = null;
      return payload === null ? undefined : this.writeAtomically(payload);
    });
    this.pendingWrite = write;
    this.tail = write.catch(() => undefined);
    return write;
  }

  /** Resolves once every queued write has settled, successfully or not. */
  flush(): Promise<void> {
    return this.tail;
  }

  private async writeAtomically(payload: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${String(process.pid)}`;
    await writeFile(temporaryPath, payload, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export function parseAutomationStore(value: unknown, now: number): AutomationStore {
  const raw = recordValue(value);
  if (!raw) throw new Error('The automations store is not an object.');
  if (raw.version !== STORE_VERSION) {
    throw new Error(
      `Unsupported automations store version ${JSON.stringify(raw.version)}; DROIDEX writes version ${String(STORE_VERSION)}.`,
    );
  }
  if (!Array.isArray(raw.automations) || !Array.isArray(raw.runs)) {
    throw new Error('The automations store is missing its automations or runs list.');
  }

  const automations = raw.automations
    .map((candidate) => parseAutomation(candidate, now))
    .filter((candidate): candidate is Automation => candidate !== null);
  const automationIds = new Set(automations.map((automation) => automation.id));
  const runs = raw.runs
    .map((candidate) => parseRun(candidate, now))
    .filter(
      (candidate): candidate is AutomationRun =>
        candidate !== null && automationIds.has(candidate.automationId),
    );
  const proposals = Array.isArray(raw.proposals)
    ? raw.proposals
        .map((candidate) => parseProposal(candidate, automationIds, now))
        .filter((candidate): candidate is AutomationProposal => candidate !== null)
    : [];
  return {
    version: STORE_VERSION,
    automations,
    runs,
    proposals,
    sessionOrigins: parseSessionOrigins(raw.sessionOrigins),
  };
}

/** Drops history beyond the retention caps without touching unsettled runs. */
export function trimAutomationStore(store: AutomationStore): void {
  store.runs = retainRuns(store.runs);
  if (store.proposals.length > MAX_PROPOSALS) {
    store.proposals = [...store.proposals]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PROPOSALS);
  }
  const origins = Object.entries(store.sessionOrigins);
  if (origins.length > MAX_ORIGINS) {
    store.sessionOrigins = Object.fromEntries(origins.slice(-MAX_ORIGINS));
  }
}

export function buildAutomationSnapshot(
  store: AutomationStore,
  scheduler: { ready: boolean; nextWakeAt: number | null; activeRunId: string | null },
): AutomationSnapshot {
  let queuedRunCount = 0;
  let activeRunCount = 0;
  for (const run of store.runs) {
    if (run.status === 'queued') queuedRunCount += 1;
    else if (isActiveRunStatus(run.status)) activeRunCount += 1;
  }
  const runs = [...store.runs]
    .sort((left, right) => right.requestedAt - left.requestedAt)
    .slice(0, SNAPSHOT_RUNS);
  const proposals = [...store.proposals]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, SNAPSHOT_PROPOSALS);
  return {
    automations: structuredClone(store.automations),
    runs: structuredClone(runs),
    proposals: structuredClone(proposals),
    sessionOrigins: structuredClone(store.sessionOrigins),
    queuedRunCount,
    activeRunCount,
    scheduler,
  };
}

/**
 * Queued and active runs are live work, never history, so they always survive.
 * Each automation also keeps its most recent settled run so a busy automation
 * cannot erase another one's last result.
 */
function retainRuns(runs: AutomationRun[]): AutomationRun[] {
  let excess = runs.length - MAX_RUNS;
  if (excess <= 0) return runs;
  const latestSettledPerAutomation = new Map<string, string>();
  for (const run of runs) {
    if (isSettledRunStatus(run.status)) latestSettledPerAutomation.set(run.automationId, run.id);
  }
  const protectedRunIds = new Set(latestSettledPerAutomation.values());
  const retained: AutomationRun[] = [];
  for (const run of runs) {
    if (excess > 0 && isSettledRunStatus(run.status) && !protectedRunIds.has(run.id)) {
      excess -= 1;
      continue;
    }
    retained.push(run);
  }
  return retained;
}

function parseAutomation(value: unknown, now: number): Automation | null {
  const raw = recordValue(value);
  if (
    !raw ||
    typeof raw.id !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.prompt !== 'string' ||
    !recordValue(raw.schedule)
  ) {
    return null;
  }
  try {
    const input: AutomationInput = {
      title: raw.title,
      prompt: raw.prompt,
      workspaceCwd: typeof raw.workspaceCwd === 'string' ? raw.workspaceCwd : null,
      executionMode: raw.executionMode === 'worktree' ? 'worktree' : 'local',
      enabled: raw.enabled !== false,
      schedule: raw.schedule as AutomationInput['schedule'],
      modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
      reasoningEffort: isReasoningEffort(raw.reasoningEffort) ? raw.reasoningEffort : null,
    };
    if (typeof raw.timezone === 'string') input.timezone = raw.timezone;
    const normalized = normalizeAutomationInput(input);
    const storedNextRunAt = finiteNumberOrNull(raw.nextRunAt);
    return {
      id: raw.id,
      ...normalized,
      nextRunAt:
        normalized.enabled && storedNextRunAt === null
          ? nextAutomationRun(normalized.schedule, normalized.timezone, now)
          : storedNextRunAt,
      lastRunAt: finiteNumberOrNull(raw.lastRunAt),
      lastRunStatus: parseRunStatus(raw.lastRunStatus),
      lastRunError: typeof raw.lastRunError === 'string' ? raw.lastRunError : null,
      lastRunDurationMs: finiteNumberOrNull(raw.lastRunDurationMs),
      lastAppSessionId: typeof raw.lastAppSessionId === 'string' ? raw.lastAppSessionId : null,
      completedAt: finiteNumberOrNull(raw.completedAt),
      createdAt: finiteNumber(raw.createdAt, now),
      updatedAt: finiteNumber(raw.updatedAt, now),
    };
  } catch {
    return null;
  }
}

function parseRun(value: unknown, now: number): AutomationRun | null {
  const raw = recordValue(value);
  const snapshot = raw ? recordValue(raw.automation) : null;
  if (
    !raw ||
    !snapshot ||
    typeof raw.id !== 'string' ||
    typeof raw.automationId !== 'string' ||
    typeof snapshot.id !== 'string' ||
    typeof snapshot.title !== 'string' ||
    typeof snapshot.prompt !== 'string'
  ) {
    return null;
  }
  return {
    id: raw.id,
    automationId: raw.automationId,
    automation: {
      id: snapshot.id,
      title: snapshot.title,
      prompt: snapshot.prompt,
      workspaceCwd: typeof snapshot.workspaceCwd === 'string' ? snapshot.workspaceCwd : null,
      executionMode: snapshot.executionMode === 'worktree' ? 'worktree' : 'local',
      timezone: typeof snapshot.timezone === 'string' ? snapshot.timezone : 'UTC',
      modelId: typeof snapshot.modelId === 'string' ? snapshot.modelId : null,
      reasoningEffort: isReasoningEffort(snapshot.reasoningEffort)
        ? snapshot.reasoningEffort
        : null,
    },
    scheduledAt: finiteNumber(raw.scheduledAt, now),
    requestedAt: finiteNumber(raw.requestedAt, now),
    trigger: raw.trigger === 'manual' ? 'manual' : 'schedule',
    status: parseRunStatus(raw.status) ?? 'failed',
    startedAt: finiteNumberOrNull(raw.startedAt),
    finishedAt: finiteNumberOrNull(raw.finishedAt),
    clientRef: typeof raw.clientRef === 'string' ? raw.clientRef : null,
    appSessionId: typeof raw.appSessionId === 'string' ? raw.appSessionId : null,
    resolvedCwd: typeof raw.resolvedCwd === 'string' ? raw.resolvedCwd : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    effectiveModelId: typeof raw.effectiveModelId === 'string' ? raw.effectiveModelId : null,
    effectiveReasoningEffort: isReasoningEffort(raw.effectiveReasoningEffort)
      ? raw.effectiveReasoningEffort
      : null,
    selectionVerified: typeof raw.selectionVerified === 'boolean' ? raw.selectionVerified : null,
  };
}

function parseProposal(
  value: unknown,
  automationIds: ReadonlySet<string>,
  now: number,
): AutomationProposal | null {
  const raw = recordValue(value);
  const draftRaw = raw ? recordValue(raw.draft) : null;
  if (
    !raw ||
    !draftRaw ||
    typeof raw.id !== 'string' ||
    typeof raw.sourceAppSessionId !== 'string' ||
    typeof draftRaw.title !== 'string' ||
    typeof draftRaw.prompt !== 'string' ||
    !recordValue(draftRaw.schedule)
  ) {
    return null;
  }
  try {
    const draft = normalizeAutomationInput({
      title: draftRaw.title,
      prompt: draftRaw.prompt,
      workspaceCwd: typeof draftRaw.workspaceCwd === 'string' ? draftRaw.workspaceCwd : null,
      executionMode: draftRaw.executionMode === 'worktree' ? 'worktree' : 'local',
      enabled: draftRaw.enabled !== false,
      schedule: draftRaw.schedule as AutomationInput['schedule'],
      ...(typeof draftRaw.timezone === 'string' ? { timezone: draftRaw.timezone } : {}),
      modelId: typeof draftRaw.modelId === 'string' ? draftRaw.modelId : null,
      reasoningEffort: isReasoningEffort(draftRaw.reasoningEffort)
        ? draftRaw.reasoningEffort
        : null,
    });
    const storedAutomationId =
      typeof raw.automationId === 'string' && automationIds.has(raw.automationId)
        ? raw.automationId
        : null;
    const storedStatus = parseProposalStatus(raw.status);
    // A confirmed proposal whose automation is gone is a draft again, never a
    // dangling link to an automation the user deleted.
    const status = storedStatus === 'confirmed' && !storedAutomationId ? 'draft' : storedStatus;
    return {
      id: raw.id,
      sourceAppSessionId: raw.sourceAppSessionId,
      draft,
      status,
      missingFields: status === 'confirmed' ? [] : missingProposalFields(draft),
      automationId: storedAutomationId,
      createdAt: finiteNumber(raw.createdAt, now),
      updatedAt: finiteNumber(raw.updatedAt, now),
      confirmedAt: finiteNumberOrNull(raw.confirmedAt),
    };
  } catch {
    return null;
  }
}

function parseSessionOrigins(value: unknown): AutomationStore['sessionOrigins'] {
  const origins = recordValue(value) ?? {};
  const sessionOrigins: AutomationStore['sessionOrigins'] = {};
  for (const [appSessionId, candidate] of Object.entries(origins)) {
    const origin = recordValue(candidate);
    if (
      !origin ||
      typeof origin.automationId !== 'string' ||
      typeof origin.automationTitle !== 'string' ||
      typeof origin.runId !== 'string'
    ) {
      continue;
    }
    sessionOrigins[appSessionId] = {
      automationId: origin.automationId,
      automationTitle: origin.automationTitle,
      runId: origin.runId,
      trigger: origin.trigger === 'manual' ? 'manual' : 'schedule',
    };
  }
  return sessionOrigins;
}

function parseProposalStatus(value: unknown): AutomationProposal['status'] {
  return value === 'confirmed' ? 'confirmed' : 'draft';
}

function parseRunStatus(value: unknown): AutomationRunStatus | null {
  return value === 'queued' ||
    value === 'starting' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed'
    ? value
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

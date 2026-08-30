import { randomUUID } from 'node:crypto';
import { assertTimeZone, nextAutomationRun, validateSchedule } from './schedule.js';
import type {
  Automation,
  AutomationInput,
  AutomationProposalMissingField,
  AutomationReasoningEffort,
} from './types.js';

export const MODEL_SELECTION_REQUIRED =
  'Choose a model and reasoning level from the DROIDEX model selector before running this automation.';

const MAX_TITLE_LENGTH = 120;
const MAX_PROMPT_LENGTH = 20_000;

/** A validated automation definition: every field is canonical and storable. */
export type NormalizedAutomationInput = Required<
  Omit<AutomationInput, 'workspaceCwd' | 'modelId' | 'reasoningEffort'>
> & {
  workspaceCwd: string | null;
  modelId: string | null;
  reasoningEffort: AutomationReasoningEffort | null;
};

export interface ModelSelection {
  modelId: string | null;
  reasoningEffort: AutomationReasoningEffort | null;
}

export function normalizeAutomationInput(input: AutomationInput): NormalizedAutomationInput {
  const title = clip(input.title.trim(), MAX_TITLE_LENGTH);
  const prompt = clip(input.prompt.trim(), MAX_PROMPT_LENGTH);
  if (!title) throw new Error('Automation title is required.');
  if (!prompt) throw new Error('Automation instructions are required.');
  validateSchedule(input.schedule);
  const timezone = (input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone).trim();
  assertTimeZone(timezone);
  const workspaceCwd = trimmedOrNull(input.workspaceCwd);
  const reasoningEffort = input.reasoningEffort ?? null;
  if (!isReasoningEffort(reasoningEffort)) {
    throw new Error('Choose a reasoning level supported by DROIDEX.');
  }
  return {
    title,
    prompt,
    workspaceCwd,
    executionMode: workspaceCwd && input.executionMode === 'worktree' ? 'worktree' : 'local',
    enabled: input.enabled !== false,
    schedule: input.schedule,
    timezone,
    modelId: trimmedOrNull(input.modelId),
    reasoningEffort,
  };
}

export function createAutomationRecord(
  normalized: NormalizedAutomationInput,
  now: number,
): Automation {
  return {
    id: randomUUID(),
    ...normalized,
    nextRunAt: normalized.enabled
      ? nextAutomationRun(normalized.schedule, normalized.timezone, now)
      : null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    lastRunDurationMs: null,
    lastAppSessionId: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function hasModelSelection(value: ModelSelection): value is {
  modelId: string;
  reasoningEffort: AutomationReasoningEffort;
} {
  return Boolean(value.modelId && value.reasoningEffort);
}

export function assertModelSelection(value: ModelSelection): asserts value is {
  modelId: string;
  reasoningEffort: AutomationReasoningEffort;
} {
  if (!hasModelSelection(value)) throw new Error(MODEL_SELECTION_REQUIRED);
}

export function missingProposalFields(value: ModelSelection): AutomationProposalMissingField[] {
  const missing: AutomationProposalMissingField[] = [];
  if (!value.modelId) missing.push('modelId');
  if (!value.reasoningEffort) missing.push('reasoningEffort');
  return missing;
}

/** Accepts `null` as well: a proposal may exist before a level is chosen. */
export function isReasoningEffort(value: unknown): value is AutomationReasoningEffort | null {
  return (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic' ||
    value === null
  );
}

export function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const clipped = value.slice(0, maximum);
  // Slicing by code unit can cut an emoji or other astral character in half.
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

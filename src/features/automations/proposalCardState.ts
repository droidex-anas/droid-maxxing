import type { TranscriptEvent } from '../../types/bridge';
import { cronExpressionIssue, deviceTimeZone, isTimeZone } from './schedule';
import { parseToolResultObject } from './toolNames';
import type { AutomationDraft, AutomationProposal, AutomationSchedule } from './types';

export interface ProposalCardState {
  kind: 'preparing' | 'ready' | 'review' | 'scheduled' | 'failed';
  label: string;
  helper: string;
}

export function proposalState({
  running,
  proposal,
  toolError,
  modelIssue,
}: {
  running: boolean;
  proposal: AutomationProposal | undefined;
  toolError: string | null;
  modelIssue: string | null;
}): ProposalCardState {
  if (toolError) {
    return { kind: 'failed', label: 'Couldn’t prepare', helper: 'Review the error and try again.' };
  }
  if (proposal?.status === 'confirmed') {
    return {
      kind: 'scheduled',
      label: 'Scheduled',
      helper: 'Saved in DROIDEX Automations and ready for its next run.',
    };
  }
  if (running || !proposal) {
    return {
      kind: 'preparing',
      label: 'Preparing',
      helper: 'Resolving this chat’s workspace, model, reasoning, and timezone.',
    };
  }
  if (proposal.missingFields.length > 0 || modelIssue) {
    return {
      kind: 'review',
      label: 'Needs review',
      helper: 'Choose the missing run details before confirming.',
    };
  }
  return {
    kind: 'ready',
    label: 'Ready to schedule',
    helper: 'Nothing runs until you confirm this proposal.',
  };
}

// A transcript replay carries no proposal id, so a card falls back to matching
// the proposals its own session created around the same time.
const PROPOSAL_MATCH_WINDOW_MS = 5 * 60 * 1_000;

export function findProposalForCall(
  proposals: readonly AutomationProposal[],
  call: TranscriptEvent,
  fallback: AutomationDraft | null,
): AutomationProposal | undefined {
  const recent = proposals.filter(
    (proposal) =>
      proposal.sourceAppSessionId === call.appSessionId &&
      Math.abs(proposal.createdAt - call.ts) < PROPOSAL_MATCH_WINDOW_MS,
  );
  if (!fallback) return recent[0];
  return (
    recent.find(
      (proposal) =>
        proposal.draft.prompt === fallback.prompt || proposal.draft.title === fallback.title,
    ) ?? recent[0]
  );
}

/**
 * Preview drawn from the tool arguments while the sidecar proposal is still in
 * flight (or after a restart dropped it), so the card never renders empty.
 *
 * These arguments come straight from the model, so the schedule and timezone are
 * validated here rather than trusted: the editor formats both through `Intl`,
 * which throws on an unknown zone or an out-of-range instant.
 */
export function draftPreviewFromToolArgs(value: unknown): AutomationDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const schedule = previewSchedule(raw.schedule);
  if (typeof raw.prompt !== 'string' || !schedule) return null;
  return {
    title:
      typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : derivePreviewTitle(raw.prompt),
    prompt: raw.prompt,
    workspaceCwd: typeof raw.workspaceCwd === 'string' ? raw.workspaceCwd : null,
    executionMode: raw.executionMode === 'worktree' ? 'worktree' : 'local',
    enabled: raw.enabled !== false,
    schedule,
    timezone:
      typeof raw.timezone === 'string' && isTimeZone(raw.timezone)
        ? raw.timezone
        : deviceTimeZone(),
    modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
    reasoningEffort: isReasoning(raw.reasoningEffort) ? raw.reasoningEffort : null,
    autonomy: isAutonomy(raw.autonomy) ? raw.autonomy : 'low',
  };
}

// End of the ECMAScript time range; a later instant cannot be formatted at all.
const MAX_EPOCH_MS = 8_640_000_000_000_000;

function previewSchedule(value: unknown): AutomationSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case 'once':
      return isEpochMs(raw.runAt) ? { kind: 'once', runAt: raw.runAt } : null;
    case 'hourly':
      return isWholeNumberWithin(raw.minute, 0, 59) ? { kind: 'hourly', minute: raw.minute } : null;
    case 'daily':
      return isWallClockTime(raw.time) ? { kind: 'daily', time: raw.time } : null;
    case 'weekdays':
      return isWallClockTime(raw.time) ? { kind: 'weekdays', time: raw.time } : null;
    case 'weekly':
      return isWallClockTime(raw.time) && isWholeNumberWithin(raw.weekday, 0, 6)
        ? { kind: 'weekly', weekday: raw.weekday, time: raw.time }
        : null;
    case 'cron':
      return typeof raw.expression === 'string' && !cronExpressionIssue(raw.expression)
        ? { kind: 'cron', expression: raw.expression }
        : null;
    default:
      return null;
  }
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_EPOCH_MS;
}

function isWholeNumberWithin(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function isWallClockTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function derivePreviewTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Scheduled task';
  const sentence = compact.split(/[.!?]/, 1)[0]?.trim() || compact;
  return sentence.length > 72 ? `${sentence.slice(0, 69).trimEnd()}…` : sentence;
}

function isReasoning(value: unknown): value is NonNullable<AutomationDraft['reasoningEffort']> {
  return (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  );
}

function isAutonomy(value: unknown): value is NonNullable<AutomationDraft['autonomy']> {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
}

export function compactError(value: string | undefined): string {
  if (!value) return 'DROIDEX could not prepare this automation.';
  const parsed = parseToolResultObject(value);
  if (parsed && typeof parsed.error === 'string') return parsed.error;
  const trimmed = value.trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}…` : trimmed;
}

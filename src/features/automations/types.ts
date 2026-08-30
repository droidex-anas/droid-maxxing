import type { Autonomy, ReasoningEffort } from '../../types/bridge';

export type AutomationSchedule =
  | { kind: 'once'; runAt: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'cron'; expression: string };

export type AutomationRunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed';

export interface AutomationDraft {
  title: string;
  prompt: string;
  workspaceCwd: string | null;
  executionMode: 'worktree' | 'local';
  enabled: boolean;
  schedule: AutomationSchedule;
  timezone: string;
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  autonomy: Autonomy;
}

export interface Automation extends AutomationDraft {
  id: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: AutomationRunStatus | null;
  lastRunError: string | null;
  lastRunDurationMs: number | null;
  lastAppSessionId: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automation: Pick<
    Automation,
    | 'id'
    | 'title'
    | 'prompt'
    | 'workspaceCwd'
    | 'executionMode'
    | 'timezone'
    | 'modelId'
    | 'reasoningEffort'
    | 'autonomy'
  >;
  scheduledAt: number;
  requestedAt: number;
  trigger: 'schedule' | 'manual';
  status: AutomationRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  clientRef: string | null;
  appSessionId: string | null;
  resolvedCwd: string | null;
  error: string | null;
  effectiveModelId: string | null;
  effectiveReasoningEffort: ReasoningEffort | null;
  selectionVerified: boolean | null;
}

export type AutomationProposalStatus = 'draft' | 'confirmed';
export type AutomationProposalMissingField = 'modelId' | 'reasoningEffort';

export interface AutomationProposal {
  id: string;
  sourceAppSessionId: string;
  draft: AutomationDraft;
  status: AutomationProposalStatus;
  missingFields: AutomationProposalMissingField[];
  automationId: string | null;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
}

export interface AutomationSessionOrigin {
  automationId: string;
  automationTitle: string;
  runId: string;
  trigger: 'schedule' | 'manual';
}

export interface AutomationSnapshot {
  automations: Automation[];
  runs: AutomationRun[];
  proposals: AutomationProposal[];
  sessionOrigins: Partial<Record<string, AutomationSessionOrigin>>;
  queuedRunCount: number;
  activeRunCount: number;
  scheduler: {
    ready: boolean;
    nextWakeAt: number | null;
    activeRunId: string | null;
  };
}

export type AutomationEditorState =
  | { mode: 'create'; draft: AutomationDraft }
  | { mode: 'edit'; automation: Automation; draft: AutomationDraft };

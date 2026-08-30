export type AutomationSchedule =
  | { kind: 'once'; runAt: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'cron'; expression: string };

export type AutomationExecutionMode = 'local' | 'worktree';
export type AutomationAutonomy = 'off' | 'low' | 'medium' | 'high';
export type AutomationRunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed';
export type AutomationTrigger = 'schedule' | 'manual';
export type AutomationReasoningEffort =
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'dynamic';

export interface AutomationInput {
  title: string;
  prompt: string;
  workspaceCwd?: string | null;
  executionMode?: AutomationExecutionMode;
  enabled?: boolean;
  schedule: AutomationSchedule;
  timezone?: string;
  modelId?: string | null;
  reasoningEffort?: AutomationReasoningEffort | null;
  autonomy?: AutomationAutonomy;
}

export interface Automation extends Required<
  Omit<AutomationInput, 'workspaceCwd' | 'modelId' | 'reasoningEffort'>
> {
  id: string;
  workspaceCwd: string | null;
  modelId: string | null;
  reasoningEffort: AutomationReasoningEffort | null;
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

export interface AutomationPatch {
  title?: string;
  prompt?: string;
  workspaceCwd?: string | null;
  executionMode?: AutomationExecutionMode;
  enabled?: boolean;
  schedule?: AutomationSchedule;
  timezone?: string;
  modelId?: string | null;
  reasoningEffort?: AutomationReasoningEffort | null;
  autonomy?: AutomationAutonomy;
}

export interface AutomationRunSnapshot {
  id: string;
  title: string;
  prompt: string;
  workspaceCwd: string | null;
  executionMode: AutomationExecutionMode;
  timezone: string;
  modelId: string | null;
  reasoningEffort: AutomationReasoningEffort | null;
  autonomy: AutomationAutonomy;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automation: AutomationRunSnapshot;
  scheduledAt: number;
  requestedAt: number;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  clientRef: string | null;
  appSessionId: string | null;
  resolvedCwd: string | null;
  error: string | null;
  effectiveModelId: string | null;
  effectiveReasoningEffort: AutomationReasoningEffort | null;
  selectionVerified: boolean | null;
}

export type AutomationProposalStatus = 'draft' | 'confirmed';
export type AutomationProposalMissingField = 'modelId' | 'reasoningEffort';

export interface AutomationProposal {
  id: string;
  sourceAppSessionId: string;
  draft: Required<Omit<AutomationInput, 'workspaceCwd' | 'modelId' | 'reasoningEffort'>> & {
    workspaceCwd: string | null;
    modelId: string | null;
    reasoningEffort: AutomationReasoningEffort | null;
  };
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
  trigger: AutomationTrigger;
}

export interface AutomationSchedulerStatus {
  ready: boolean;
  nextWakeAt: number | null;
  activeRunId: string | null;
}

export interface AutomationStore {
  version: 1;
  automations: Automation[];
  runs: AutomationRun[];
  proposals: AutomationProposal[];
  /** Which run started a chat, for the chats an automation started. */
  sessionOrigins: Partial<Record<string, AutomationSessionOrigin>>;
}

export interface AutomationSnapshot {
  automations: Automation[];
  runs: AutomationRun[];
  proposals: AutomationProposal[];
  sessionOrigins: Partial<Record<string, AutomationSessionOrigin>>;
  queuedRunCount: number;
  activeRunCount: number;
  scheduler: AutomationSchedulerStatus;
}

export type AutomationBridgeEvent =
  | { type: 'automations.snapshot'; snapshot: AutomationSnapshot }
  | { type: 'automations.result'; requestId: string; ok: boolean; error?: string };

export type AutomationBridgeCommand =
  | { type: 'automations.list'; requestId: string }
  | { type: 'automations.create'; requestId: string; input: AutomationInput }
  | { type: 'automations.update'; requestId: string; id: string; patch: AutomationPatch }
  | { type: 'automations.delete'; requestId: string; id: string }
  | { type: 'automations.setEnabled'; requestId: string; id: string; enabled: boolean }
  | { type: 'automations.runNow'; requestId: string; id: string }
  | {
      type: 'automations.confirmProposal';
      requestId: string;
      id: string;
      input?: AutomationInput;
    };

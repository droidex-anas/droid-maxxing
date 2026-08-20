export type AutomationSchedule =
  | { kind: 'once'; runAt: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'cron'; expression: string };

export type AutomationRunStatus = 'queued' | 'running' | 'launched' | 'failed';

export interface Automation {
  id: string;
  title: string;
  prompt: string;
  workspaceCwd: string | null;
  executionMode: 'worktree' | 'local';
  enabled: boolean;
  schedule: AutomationSchedule;
  timezone: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: AutomationRunStatus | null;
  lastAppSessionId: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationDraft {
  title: string;
  prompt: string;
  workspaceCwd: string | null;
  executionMode: 'worktree' | 'local';
  enabled: boolean;
  schedule: AutomationSchedule;
}

export interface AutomationRunSnapshot {
  id: string;
  title: string;
  prompt: string;
  workspaceCwd: string | null;
  executionMode: 'worktree' | 'local';
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automation: AutomationRunSnapshot;
  scheduledAt: number;
  requestedAt: number;
  trigger: 'schedule' | 'manual';
  status: AutomationRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  clientRef: string | null;
  appSessionId: string | null;
  error: string | null;
}

export type AutomationEditorState =
  | { mode: 'create'; draft: AutomationDraft }
  | { mode: 'edit'; automation: Automation; draft: AutomationDraft };

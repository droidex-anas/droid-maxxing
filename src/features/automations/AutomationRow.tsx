import {
  CircleAlert,
  CirclePause,
  Clock,
  History,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { HoverTooltip } from '../../components/HoverTooltip';
import type { ModelInfo } from '../../types/bridge';
import {
  formatAutomationRunStatus,
  formatNextRun,
  formatSchedule,
  isAutomationRunActive,
  workspaceLabel,
} from './schedule';
import type { Automation, AutomationRun } from './types';

/** One row of the Automations list: its schedule, its run state, and its actions. */
export function AutomationRow({
  automation,
  run: snapshotRun,
  model,
  modelIssue,
  now,
  deleteArmed,
  last,
  onEdit,
  onToggle,
  onRun,
  onOpenSession,
  onDelete,
}: {
  automation: Automation;
  run: AutomationRun | undefined;
  model: ModelInfo | undefined;
  modelIssue: string | null;
  now: number;
  deleteArmed: boolean;
  last: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onRun: () => void;
  onOpenSession: (appSessionId: string) => void;
  onDelete: () => void;
}) {
  const run = snapshotRun ?? persistedLastRun(automation);
  const active = isAutomationRunActive(run);
  const needsSetup = modelIssue !== null;
  const status = needsSetup && !active ? 'Setup required' : formatAutomationRunStatus(run, now);
  const error = run?.status === 'failed' ? run.error : modelIssue;
  const statusContent = (
    <span
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 ${statusClass(run, needsSetup)}`}
    >
      <RunStatusIcon run={run} needsSetup={needsSetup} />
      <span>{status}</span>
    </span>
  );

  return (
    <div
      className={`group flex min-h-[92px] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-droid-elevated/32 ${
        last ? '' : 'border-b border-droid-border/60'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${statusTileClass(
          run,
          needsSetup,
          automation.enabled,
        )}`}
      >
        <RunStatusIcon run={run} large enabled={automation.enabled} needsSetup={needsSetup} />
      </span>

      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[13.5px] font-medium text-droid-text">{automation.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-droid-text-muted">
          <span>{formatSchedule(automation.schedule, automation.timezone)}</span>
          <span aria-hidden>·</span>
          <span>{workspaceLabel(automation.workspaceCwd)}</span>
          <span aria-hidden>·</span>
          <span>{model?.displayName ?? automation.modelId ?? 'Choose a model'}</span>
          <span aria-hidden>·</span>
          <span className="capitalize">
            {automation.reasoningEffort
              ? `${automation.reasoningEffort} reasoning`
              : 'Choose reasoning'}
          </span>
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px]">
          {error ? (
            <HoverTooltip label={error} placement="bottom" delay={180}>
              {statusContent}
            </HoverTooltip>
          ) : (
            statusContent
          )}
          <span className="truncate text-droid-text-muted/75">
            {rowHint(automation, run, active, needsSetup)}
          </span>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {run?.appSessionId && (
          <RowAction
            label={active ? 'Open running chat' : 'Open last run chat'}
            onClick={() => {
              if (run.appSessionId) onOpenSession(run.appSessionId);
            }}
          >
            <MessageSquareText className="h-3.5 w-3.5" />
          </RowAction>
        )}
        <RowAction
          label={
            needsSetup
              ? 'Choose a model and reasoning before running'
              : active
                ? 'This automation is already active'
                : 'Run now and open its chat'
          }
          onClick={onRun}
          disabled={active || needsSetup}
        >
          <Play className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction label="Edit automation" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction
          label={automation.enabled ? 'Pause schedule' : 'Resume schedule'}
          onClick={onToggle}
        >
          {automation.enabled ? (
            <CirclePause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </RowAction>
        <RowAction
          label={deleteArmed ? 'Click again to delete' : 'Delete automation'}
          onClick={onDelete}
          danger={deleteArmed}
          disabled={active}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </RowAction>
      </div>
    </div>
  );
}

/**
 * The snapshot only carries a bounded window of recent runs, so an automation
 * whose last run has aged out of it falls back to the fields persisted on the
 * record. Without this the row claims "Never run" and drops its failure state
 * and its run chat link.
 */
function persistedLastRun(automation: Automation): AutomationRun | undefined {
  const { lastRunAt, lastRunStatus, lastRunDurationMs } = automation;
  if (lastRunAt === null || lastRunStatus === null) return undefined;
  return {
    id: `${automation.id}:last-run`,
    automationId: automation.id,
    automation,
    scheduledAt: lastRunAt,
    requestedAt: lastRunAt,
    trigger: 'schedule',
    status: lastRunStatus,
    startedAt: lastRunAt,
    finishedAt: lastRunDurationMs === null ? automation.completedAt : lastRunAt + lastRunDurationMs,
    clientRef: null,
    appSessionId: automation.lastAppSessionId,
    resolvedCwd: null,
    error: automation.lastRunError,
    effectiveModelId: automation.modelId,
    effectiveReasoningEffort: automation.reasoningEffort,
    selectionVerified: null,
  };
}

function rowHint(
  automation: Automation,
  run: AutomationRun | undefined,
  active: boolean,
  needsSetup: boolean,
): string {
  if (active) {
    return run?.status === 'queued'
      ? 'Waiting for the current automation slot'
      : 'The run chat is receiving live model activity';
  }
  if (needsSetup) return 'Open this automation and choose an available model and reasoning level';
  return formatNextRun(automation.nextRunAt, automation.completedAt, automation.timezone);
}

function RowAction({
  label,
  onClick,
  children,
  disabled = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <HoverTooltip label={label} delay={220}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`rounded-lg p-2 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-droid-border-hover disabled:cursor-not-allowed disabled:opacity-35 ${
          danger
            ? 'bg-red-500/12 text-red-400 hover:bg-red-500/20'
            : 'text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text'
        }`}
      >
        {children}
      </button>
    </HoverTooltip>
  );
}

function SetupRequiredIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 1-6.4 2.7" strokeDasharray="3.1 2.4" />
      <circle cx="12" cy="12" r="1.45" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RunStatusIcon({
  run,
  large = false,
  enabled = true,
  needsSetup = false,
}: {
  run: AutomationRun | undefined;
  large?: boolean;
  enabled?: boolean;
  needsSetup?: boolean;
}) {
  const size = large ? 'h-4 w-4' : 'h-3 w-3';
  if (needsSetup && !isAutomationRunActive(run)) {
    return <SetupRequiredIcon className={`${size} text-amber-300`} />;
  }
  if (!run) {
    return enabled ? (
      <Clock className={`${size} text-droid-text-muted`} />
    ) : (
      <CirclePause className={`${size} text-droid-text-muted/60`} />
    );
  }
  switch (run.status) {
    case 'queued':
      return <Clock className={`${size} text-droid-text-muted`} />;
    case 'starting':
    case 'running':
      return <LoaderCircle className={`${size} animate-spin text-droid-text-secondary`} />;
    case 'completed':
      return <History className={`${size} text-droid-text-secondary`} />;
    case 'failed':
      return <CircleAlert className={`${size} text-red-400`} />;
  }
}

function statusTileClass(
  run: AutomationRun | undefined,
  needsSetup: boolean,
  enabled: boolean,
): string {
  if (needsSetup && !isAutomationRunActive(run)) {
    return 'border-amber-300/20 bg-amber-300/5';
  }
  if (run?.status === 'failed') return 'border-red-400/20 bg-red-400/5';
  if (run?.status === 'completed') return 'border-droid-border bg-droid-surface/48';
  if (run?.status === 'running' || run?.status === 'starting') {
    return 'border-droid-border-hover bg-droid-elevated/75';
  }
  if (!enabled) return 'border-droid-border/70 bg-droid-surface/30';
  return 'border-droid-border bg-droid-surface/65';
}

function statusClass(run: AutomationRun | undefined, needsSetup = false): string {
  if (needsSetup && !isAutomationRunActive(run)) return 'text-amber-300';
  if (run?.status === 'failed') return 'text-red-400';
  if (run?.status === 'completed') return 'text-droid-text-secondary';
  if (run?.status === 'running' || run?.status === 'starting') return 'text-droid-text-secondary';
  return 'text-droid-text-muted';
}

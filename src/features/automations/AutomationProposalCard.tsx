import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { toast } from '../../lib/toast';
import type { TranscriptEvent } from '../../types/bridge';
import { EditorRow, ScheduleControls, scheduleForKind } from './AutomationEditor';
import { AutomationModelPicker } from './AutomationModelPicker';
import {
  confirmAutomationProposal,
  requestAutomationSnapshot,
  useAutomationSnapshot,
} from './client';
import { automationModelSelectionIssue, validateAutomationModelSelection } from './modelSelection';
import { SelectMenu } from './SelectMenu';
import { automationProposalIdFromText } from './toolNames';
import {
  compactError,
  draftPreviewFromToolArgs,
  findProposalForCall,
  proposalState,
  type ProposalCardState,
} from './proposalCardState';
import {
  convertOnceRunAt,
  formatSchedule,
  supportedTimeZones,
  validateAutomationDraft,
  workspaceLabel,
} from './schedule';
import type { AutomationDraft, AutomationSchedule } from './types';

const EASE = [0.16, 1, 0.3, 1] as const;

export function AutomationProposalCard({
  call,
  result,
  running,
}: {
  call: TranscriptEvent;
  result?: TranscriptEvent;
  running: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const dispatch = useStoreDispatch();
  const snapshot = useAutomationSnapshot();
  const models = useStoreSelector((state) => state.models);
  const workspaceCwds = useStoreSelector((state) => state.workspaceCwds);
  const [confirming, setConfirming] = useState(false);
  // Local edits stay on the card until confirm; the server proposal only
  // changes through confirmAutomationProposal, so there is one write path.
  const [overrides, setOverrides] = useState<AutomationDraft | null>(null);
  const proposalId = automationProposalIdFromText(result?.text);
  const fallback = useMemo(() => draftPreviewFromToolArgs(call.toolArgs), [call.toolArgs]);
  const proposal = useMemo(
    () =>
      (proposalId
        ? snapshot.proposals.find((candidate) => candidate.id === proposalId)
        : undefined) ?? findProposalForCall(snapshot.proposals, call, fallback),
    [call, fallback, proposalId, snapshot.proposals],
  );
  const draft = proposal?.draft ?? fallback;
  const workingDraft = overrides ?? draft;
  const selectedModel = workingDraft?.modelId
    ? models.find((candidate) => candidate.id === workingDraft.modelId)
    : undefined;
  const strictModelIssue = workingDraft
    ? validateAutomationModelSelection(models, workingDraft.modelId, workingDraft.reasoningEffort)
    : 'Preparing the automation details.';
  const displayModelIssue = workingDraft
    ? automationModelSelectionIssue(models, workingDraft.modelId, workingDraft.reasoningEffort)
    : null;
  const toolError = result?.isError ? compactError(result.text) : null;
  const state = proposalState({ running, proposal, toolError, modelIssue: strictModelIssue });
  const confirmedAutomation = proposal?.automationId
    ? snapshot.automations.find((automation) => automation.id === proposal.automationId)
    : undefined;
  const scheduledAutomationId =
    state.kind === 'scheduled' ? (proposal?.automationId ?? null) : null;
  const validation = workingDraft ? validateAutomationDraft(workingDraft, models) : null;
  const timeZones = useMemo(
    () =>
      supportedTimeZones().map((timezone) => ({
        value: timezone,
        label: timezone
          .split('/')
          .map((part) => part.replaceAll('_', ' '))
          .join(' / '),
        keywords: timezone,
      })),
    [],
  );

  useEffect(() => {
    if (proposal || toolError) return;
    // The card renders from the streamed call immediately, then asks twice for
    // authoritative proposal state. The second bounded request covers a bridge
    // reconnect or the small race where the tool call reaches the transcript a
    // moment before AutomationManager finishes persisting its proposal.
    requestAutomationSnapshot();
    const retry = window.setTimeout(requestAutomationSnapshot, 420);
    return () => {
      window.clearTimeout(retry);
    };
  }, [call.toolUseId, proposal, proposalId, toolError]);

  const updateDraft = (patch: Partial<AutomationDraft>) => {
    if (!workingDraft) return;
    setOverrides({ ...workingDraft, ...patch });
  };
  const updateSchedule = (schedule: AutomationSchedule) => {
    updateDraft({ schedule });
  };
  const updateTimezone = (timezone: string) => {
    if (!workingDraft) return;
    if (workingDraft.schedule.kind !== 'once') {
      updateDraft({ timezone });
      return;
    }
    updateDraft({
      timezone,
      schedule: {
        kind: 'once',
        runAt: convertOnceRunAt(workingDraft.schedule.runAt, workingDraft.timezone, timezone),
      },
    });
  };

  const confirm = async () => {
    if (!proposal || confirming || strictModelIssue || validation) return;
    setConfirming(true);
    try {
      await confirmAutomationProposal(proposal.id, overrides ?? undefined);
      toast.success('Automation scheduled.');
      setOverrides(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not schedule this automation.');
    } finally {
      setConfirming(false);
    }
  };

  const confirmDisabled = !proposal || confirming || state.kind === 'failed' || Boolean(validation);
  const helper = validation ?? state.helper;

  return (
    <motion.section
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE }}
      className="overflow-hidden rounded-2xl border border-droid-border bg-droid-surface/35"
      aria-label="DROIDEX automation proposal"
    >
      <div className="px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-droid-text-muted">
            DROIDEX automation
          </span>
          <StateIndicator state={state} />
        </div>
        {scheduledAutomationId && workingDraft ? (
          <h3 className="mt-2 text-[15px] font-medium leading-6 tracking-[-0.01em] text-droid-text">
            {workingDraft.title}
          </h3>
        ) : (
          <input
            value={workingDraft?.title ?? ''}
            onChange={(event) => {
              updateDraft({ title: event.target.value });
            }}
            disabled={!workingDraft}
            placeholder={workingDraft ? 'Automation title' : 'Preparing automation'}
            aria-label="Automation title"
            className="mt-2 w-full bg-transparent text-[15px] font-medium leading-6 tracking-[-0.01em] text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/50 disabled:cursor-default"
          />
        )}
        <p className="mt-1 line-clamp-3 text-[12.5px] leading-5 text-droid-text-muted">
          {workingDraft?.prompt ?? 'DROIDEX is resolving the schedule and run configuration.'}
        </p>
      </div>

      {workingDraft ? (
        scheduledAutomationId ? (
          <dl className="border-t border-droid-border/70">
            <ViewRow
              label="Schedule"
              value={formatSchedule(workingDraft.schedule, workingDraft.timezone)}
            />
            <ViewRow label="Time zone" value={workingDraft.timezone} />
            <ViewRow
              label="Model"
              value={
                selectedModel
                  ? `${selectedModel.displayName} · ${workingDraft.reasoningEffort ?? 'default'} reasoning`
                  : (workingDraft.modelId ?? 'No model')
              }
            />
            <ViewRow
              label="Workspace"
              value={
                workingDraft.workspaceCwd
                  ? `${workspaceLabel(workingDraft.workspaceCwd)} · ${
                      workingDraft.executionMode === 'worktree'
                        ? 'Isolated worktree'
                        : 'Current checkout'
                    }`
                  : 'No workspace'
              }
              last
            />
          </dl>
        ) : (
          <div className="border-t border-droid-border/70 px-4 pb-1 pt-1">
            <EditorRow label="Repeat">
              <SelectMenu
                value={workingDraft.schedule.kind}
                ariaLabel="Automation frequency"
                onChange={(value) => {
                  updateSchedule(scheduleForKind(value, workingDraft.schedule));
                }}
                options={[
                  { value: 'once', label: 'Once' },
                  { value: 'hourly', label: 'Hourly' },
                  { value: 'daily', label: 'Daily' },
                  { value: 'weekdays', label: 'Weekdays' },
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'cron', label: 'Custom schedule' },
                ]}
              />
            </EditorRow>
            <ScheduleControls
              schedule={workingDraft.schedule}
              timezone={workingDraft.timezone}
              onChange={updateSchedule}
            />
            <EditorRow label="Time zone">
              <SelectMenu
                value={workingDraft.timezone}
                ariaLabel="Automation timezone"
                searchable
                width={340}
                options={timeZones}
                onChange={updateTimezone}
              />
            </EditorRow>
            <EditorRow label="Model">
              <AutomationModelPicker
                models={models}
                modelId={workingDraft.modelId}
                reasoningEffort={workingDraft.reasoningEffort}
                onChange={(selection) => {
                  updateDraft({
                    modelId: selection.modelId,
                    reasoningEffort: selection.reasoningEffort,
                  });
                }}
              />
            </EditorRow>
            <EditorRow label="Workspace">
              <SelectMenu
                value={workingDraft.workspaceCwd ?? ''}
                ariaLabel="Automation workspace"
                searchable
                width={330}
                onChange={(value) => {
                  updateDraft({
                    workspaceCwd: value || null,
                    executionMode: value ? workingDraft.executionMode : 'local',
                  });
                }}
                options={[
                  { value: '', label: 'No workspace', detail: 'Run as a folder-less chat' },
                  ...workspaceCwds.map((cwd) => ({
                    value: cwd,
                    label: workspaceLabel(cwd),
                    detail: cwd,
                  })),
                ]}
              />
            </EditorRow>
            <EditorRow label="Checkout" last>
              <SelectMenu
                value={workingDraft.executionMode}
                ariaLabel="Automation checkout mode"
                disabled={!workingDraft.workspaceCwd}
                onChange={(value) => {
                  updateDraft({ executionMode: value === 'worktree' ? 'worktree' : 'local' });
                }}
                options={[
                  {
                    value: 'local',
                    label: 'Current workspace',
                    detail: 'Runs in the selected checkout',
                  },
                  {
                    value: 'worktree',
                    label: 'Isolated worktree',
                    detail: 'Creates a clean detached checkout for the run',
                  },
                ]}
              />
            </EditorRow>
          </div>
        )
      ) : null}

      {(toolError ?? displayModelIssue) && state.kind !== 'scheduled' && (
        <div className="border-t border-droid-border/70 px-4 py-2.5">
          <p
            className={`text-[11.5px] leading-4 ${
              toolError ? 'text-red-300/90' : 'text-amber-200/80'
            }`}
          >
            {toolError ?? displayModelIssue}
          </p>
        </div>
      )}

      <div className="flex min-h-12 items-center justify-between gap-3 border-t border-droid-border/70 bg-droid-bg/20 px-4 py-2.5">
        <span className="text-[10.5px] leading-4 text-droid-text-muted">{helper}</span>
        <div className="flex shrink-0 items-center gap-2">
          {scheduledAutomationId ? (
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'OPEN_AUTOMATIONS', automationId: scheduledAutomationId });
              }}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
            >
              Open automation
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={confirmDisabled}
              className="rounded-lg bg-droid-text px-3.5 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {confirming ? 'Scheduling…' : 'Confirm automation'}
            </button>
          )}
        </div>
      </div>

      {confirmedAutomation?.nextRunAt && (
        <div className="sr-only">
          Next run at {new Date(confirmedAutomation.nextRunAt).toString()}
        </div>
      )}
    </motion.section>
  );
}

function StateIndicator({ state }: { state: ProposalCardState }) {
  const dot =
    state.kind === 'failed'
      ? 'bg-red-400/80'
      : state.kind === 'review'
        ? 'bg-amber-300/70'
        : state.kind === 'preparing'
          ? 'bg-droid-text-muted motion-safe:animate-pulse'
          : 'bg-droid-text-secondary';
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-droid-text-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {state.label}
    </span>
  );
}

function ViewRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 px-4 py-2.5 ${
        last ? '' : 'border-b border-droid-border/60'
      }`}
    >
      <dt className="shrink-0 text-[11px] text-droid-text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[12px] font-medium text-droid-text-secondary">
        {value}
      </dd>
    </div>
  );
}

import { X } from 'lucide-react';
import { useId, useMemo, type ReactNode } from 'react';
import type { WorkspaceScope } from '../../lib/workspaces';
import type { ModelInfo } from '../../types/bridge';
import { AutomationModelPicker } from './AutomationModelPicker';
import { SelectMenu } from './SelectMenu';
import {
  AUTOMATION_AUTONOMY_OPTIONS,
  convertOnceRunAt,
  epochFromZonedInput,
  supportedTimeZones,
  validateAutomationDraft,
  WEEKDAYS,
  workspaceLabel,
  zonedInputParts,
} from './schedule';
import {
  AutomationDateInput,
  AutomationMinuteInput,
  AutomationTimeInput,
  clampNumber,
} from './TimeFields';
import type { AutomationDraft, AutomationEditorState, AutomationSchedule } from './types';

interface AutomationEditorProps {
  editor: AutomationEditorState;
  workspaceScopes: readonly WorkspaceScope[];
  // Workspace discovery is asynchronous; until it settles an unknown workspace
  // path in the draft is not yet evidence that the workspace disappeared.
  workspaceScopesReady: boolean;
  models: ModelInfo[];
  onChange: (draft: AutomationDraft) => void;
  onSave: () => void;
  onClose: () => void;
}

const CONTROL =
  'w-full rounded-xl border border-droid-border bg-droid-surface/55 px-3 py-2.5 text-[13px] text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/60 focus:border-droid-border-hover focus:bg-droid-surface';

export function AutomationEditor({
  editor,
  workspaceScopes,
  workspaceScopesReady,
  models,
  onChange,
  onSave,
  onClose,
}: AutomationEditorProps) {
  const { draft } = editor;
  const validation = useMemo(
    () =>
      validateAutomationDraft(draft, models) ??
      missingWorkspaceIssue(draft, workspaceScopes, workspaceScopesReady),
    [draft, models, workspaceScopes, workspaceScopesReady],
  );
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

  const update = <Key extends keyof AutomationDraft>(key: Key, value: AutomationDraft[Key]) => {
    onChange({ ...draft, [key]: value });
  };
  const updateSchedule = (schedule: AutomationSchedule) => {
    update('schedule', schedule);
  };
  const updateTimezone = (timezone: string) => {
    if (draft.schedule.kind !== 'once') {
      update('timezone', timezone);
      return;
    }
    onChange({
      ...draft,
      timezone,
      schedule: {
        kind: 'once',
        runAt: convertOnceRunAt(draft.schedule.runAt, draft.timezone, timezone),
      },
    });
  };

  return (
    <aside className="flex h-full w-[410px] flex-col border-l border-droid-border bg-droid-bg shadow-2xl shadow-black/25">
      <div data-electron-drag-region className="h-9 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-5 pb-3 pt-2">
          <div>
            <div className="text-[12px] font-medium text-droid-text-secondary">
              {editor.mode === 'create' ? 'New automation' : 'Edit automation'}
            </div>
            <div className="mt-0.5 text-[10.5px] text-droid-text-muted">
              Schedule a task that runs as a DROIDEX chat
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
            aria-label="Close automation editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
          <input
            value={draft.title}
            onChange={(event) => {
              update('title', event.target.value);
            }}
            placeholder="Automation title"
            className="mb-4 w-full bg-transparent text-[22px] font-medium tracking-[-0.02em] text-droid-text outline-none placeholder:text-droid-text-muted/50"
            autoFocus
          />
          <textarea
            value={draft.prompt}
            onChange={(event) => {
              update('prompt', event.target.value);
            }}
            placeholder="Describe the task DROIDEX should complete each time"
            rows={6}
            className={`${CONTROL} resize-none leading-5`}
          />

          <SectionLabel>Run configuration</SectionLabel>
          <div className="overflow-visible rounded-2xl border border-droid-border bg-droid-surface/35">
            <EditorRow label="Model">
              <AutomationModelPicker
                models={models}
                modelId={draft.modelId}
                reasoningEffort={draft.reasoningEffort}
                onChange={(selection) => {
                  onChange({
                    ...draft,
                    modelId: selection.modelId,
                    reasoningEffort: selection.reasoningEffort,
                  });
                }}
              />
            </EditorRow>
            <EditorRow label="Autonomy">
              <SelectMenu
                value={draft.autonomy}
                ariaLabel="Automation autonomy"
                onChange={(value) => {
                  update('autonomy', value as AutomationDraft['autonomy']);
                }}
                options={AUTOMATION_AUTONOMY_OPTIONS}
              />
            </EditorRow>
            <EditorRow label="Workspace">
              <SelectMenu
                value={draft.workspaceCwd ?? ''}
                ariaLabel="Automation workspace"
                searchable
                width={330}
                onChange={(value) => {
                  onChange({
                    ...draft,
                    workspaceCwd: value || null,
                    executionMode: value ? draft.executionMode : 'local',
                  });
                }}
                options={[
                  { value: '', label: 'No workspace', detail: 'Run as a folder-less chat' },
                  ...workspaceScopes.map((scope) => ({
                    value: scope.cwd,
                    label: workspaceLabel(scope.cwd),
                    detail: scope.cwd,
                  })),
                ]}
              />
            </EditorRow>
            <EditorRow label="Checkout" last>
              <SelectMenu
                value={draft.executionMode}
                ariaLabel="Automation checkout mode"
                disabled={!draft.workspaceCwd}
                onChange={(value) => {
                  update('executionMode', value as 'worktree' | 'local');
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

          <SectionLabel>Schedule</SectionLabel>
          <div className="overflow-visible rounded-2xl border border-droid-border bg-droid-surface/35">
            <EditorRow label="Repeat">
              <SelectMenu
                value={draft.schedule.kind}
                ariaLabel="Automation frequency"
                onChange={(value) => {
                  updateSchedule(scheduleForKind(value, draft.schedule));
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
              schedule={draft.schedule}
              timezone={draft.timezone}
              onChange={updateSchedule}
            />
            <EditorRow label="Time zone">
              <SelectMenu
                value={draft.timezone}
                ariaLabel="Automation timezone"
                searchable
                width={340}
                options={timeZones}
                onChange={updateTimezone}
              />
            </EditorRow>
            <EditorRow label="Status" last>
              <SelectMenu
                value={draft.enabled ? 'active' : 'paused'}
                ariaLabel="Automation status"
                onChange={(value) => {
                  update('enabled', value === 'active');
                }}
                options={[
                  { value: 'active', label: 'Active', detail: 'Runs at the scheduled time' },
                  {
                    value: 'paused',
                    label: 'Paused',
                    detail: 'Keeps the automation without running it',
                  },
                ]}
              />
            </EditorRow>
          </div>

          <div className="mt-4 rounded-xl border border-droid-border/70 bg-droid-surface/25 px-3 py-2.5 text-[11px] leading-4 text-droid-text-muted">
            Every run opens as a background chat. Automations shows whether it is queued, starting,
            running, completed, or failed, and lets you open the run chat directly.
          </div>
        </div>

        <div className="border-t border-droid-border px-5 py-4">
          {validation && <p className="mb-2 text-[11px] text-droid-text-muted">{validation}</p>}
          <button
            type="button"
            onClick={onSave}
            disabled={Boolean(validation)}
            className="ml-auto block rounded-xl bg-droid-text px-4 py-2 text-[13px] font-medium text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {editor.mode === 'create' ? 'Create automation' : 'Save changes'}
          </button>
        </div>
      </div>
    </aside>
  );
}

export function ScheduleControls({
  schedule,
  timezone,
  onChange,
}: {
  schedule: AutomationSchedule;
  timezone: string;
  onChange: (schedule: AutomationSchedule) => void;
}) {
  switch (schedule.kind) {
    case 'once': {
      const parts = zonedInputParts(schedule.runAt, timezone);
      const minimumDate = zonedInputParts(Date.now(), timezone);
      return (
        <>
          <EditorRow label="Date">
            <AutomationDateInput
              value={parts}
              minimum={minimumDate}
              onChange={(date) => {
                onChange({
                  kind: 'once',
                  runAt: epochFromZonedInput({ ...parts, ...date }, timezone),
                });
              }}
            />
          </EditorRow>
          <EditorRow label="Time">
            <AutomationTimeInput
              value={`${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`}
              onChange={(time) => {
                const [hourText = '', minuteText = ''] = time.split(':');
                onChange({
                  kind: 'once',
                  runAt: epochFromZonedInput(
                    {
                      ...parts,
                      hour: clampNumber(hourText, 0, 23, parts.hour),
                      minute: clampNumber(minuteText, 0, 59, parts.minute),
                    },
                    timezone,
                  ),
                });
              }}
            />
          </EditorRow>
        </>
      );
    }
    case 'hourly':
      return (
        <EditorRow label="At">
          <AutomationMinuteInput
            value={schedule.minute}
            onChange={(minute) => {
              onChange({ kind: 'hourly', minute });
            }}
          />
        </EditorRow>
      );
    case 'daily':
    case 'weekdays':
      return (
        <EditorRow label="At">
          <AutomationTimeInput
            value={schedule.time}
            onChange={(time) => {
              onChange({ kind: schedule.kind, time });
            }}
          />
        </EditorRow>
      );
    case 'weekly':
      return (
        <>
          <EditorRow label="On">
            <SelectMenu
              value={String(schedule.weekday)}
              ariaLabel="Automation weekday"
              onChange={(value) => {
                onChange({ ...schedule, weekday: Number(value) });
              }}
              options={WEEKDAYS.map((weekday, index) => ({
                value: String(index),
                label: weekday,
              }))}
            />
          </EditorRow>
          <EditorRow label="At">
            <AutomationTimeInput
              value={schedule.time}
              onChange={(time) => {
                onChange({ ...schedule, time });
              }}
            />
          </EditorRow>
        </>
      );
    case 'cron':
      return (
        <EditorRow label="Expression">
          <div className="w-[215px]">
            <input
              value={schedule.expression}
              aria-label="Cron expression"
              onChange={(event) => {
                onChange({ kind: 'cron', expression: event.target.value });
              }}
              placeholder="0 9 * * 1-5"
              className="w-full rounded-lg border border-droid-border bg-droid-bg/70 px-2.5 py-1.5 text-right text-[12px] tabular-nums text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/50 focus:border-droid-border-hover"
            />
            <div className="mt-1 text-right text-[10px] text-droid-text-muted">
              minute · hour · day · month · weekday
            </div>
          </div>
        </EditorRow>
      );
  }
}

// A saved workspace can disappear from discovery. The picker then shows nothing
// selected while the draft still carries the old path, so saving is blocked
// until the user picks an available workspace or clears it. Nothing is claimed
// missing before discovery reports its result.
function missingWorkspaceIssue(
  draft: AutomationDraft,
  workspaceScopes: readonly WorkspaceScope[],
  workspaceScopesReady: boolean,
): string | null {
  const cwd = draft.workspaceCwd;
  if (cwd === null || !workspaceScopesReady) return null;
  if (workspaceScopes.some((scope) => scope.cwd === cwd)) return null;
  return `${workspaceLabel(cwd)} is no longer available. Choose a workspace or select No workspace.`;
}

export function scheduleForKind(kind: string, current: AutomationSchedule): AutomationSchedule {
  const time = 'time' in current ? current.time : '09:00';
  switch (kind) {
    case 'once':
      return { kind: 'once', runAt: Date.now() + 60 * 60 * 1_000 };
    case 'hourly':
      return { kind: 'hourly', minute: 0 };
    case 'weekdays':
      return { kind: 'weekdays', time };
    case 'weekly':
      return { kind: 'weekly', weekday: 1, time };
    case 'cron':
      return { kind: 'cron', expression: '0 9 * * 1-5' };
    default:
      return { kind: 'daily', time };
  }
}

function SectionLabel({ children }: { children: string }) {
  return <h3 className="mb-2 mt-6 text-[12px] font-medium text-droid-text-muted">{children}</h3>;
}

export function EditorRow({
  label,
  children,
  last = false,
}: {
  label: string;
  children: ReactNode;
  last?: boolean;
}) {
  const captionId = useId();
  return (
    <div
      className={`flex min-h-12 items-center justify-between gap-4 px-3.5 py-2 text-[13px] ${
        last ? '' : 'border-b border-droid-border/70'
      }`}
    >
      <span id={captionId} className="shrink-0 text-droid-text-secondary">
        {label}
      </span>
      {/* The caption is the only visible name for the row's control, so it is
          published as the group name rather than left as decorative text. */}
      <div role="group" aria-labelledby={captionId} className="min-w-0 text-right">
        {children}
      </div>
    </div>
  );
}

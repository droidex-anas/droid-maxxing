import { ChevronDown, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { WorkspaceScope } from '../../lib/workspaces';
import {
  toLocalDateTimeInput,
  validateAutomationDraft,
  WEEKDAYS,
  workspaceLabel,
} from './schedule';
import type { AutomationDraft, AutomationEditorState, AutomationSchedule } from './types';

interface AutomationEditorProps {
  editor: AutomationEditorState;
  workspaceScopes: readonly WorkspaceScope[];
  onChange: (draft: AutomationDraft) => void;
  onSave: () => void;
  onClose: () => void;
}

const CONTROL =
  'w-full rounded-xl border border-droid-border bg-droid-surface px-3 py-2.5 text-[13px] text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/60 focus:border-droid-text-muted';

export function AutomationEditor({
  editor,
  workspaceScopes,
  onChange,
  onSave,
  onClose,
}: AutomationEditorProps) {
  const { draft } = editor;
  const validation = useMemo(() => validateAutomationDraft(draft), [draft]);
  const update = <Key extends keyof AutomationDraft>(key: Key, value: AutomationDraft[Key]) => {
    onChange({ ...draft, [key]: value });
  };
  const updateSchedule = (schedule: AutomationSchedule) => {
    update('schedule', schedule);
  };

  return (
    <aside className="flex h-full w-[390px] shrink-0 flex-col border-l border-droid-border bg-droid-bg">
      <div data-electron-drag-region className="h-9 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-5 pb-3 pt-2">
          <span className="text-[12px] font-medium text-droid-text-muted">
            {editor.mode === 'create' ? 'New automation' : 'Edit automation'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
            aria-label="Close automation editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
          <input
            value={draft.title}
            onChange={(event) => update('title', event.target.value)}
            placeholder="Automation title"
            className="mb-4 w-full bg-transparent text-[22px] font-medium tracking-[-0.02em] text-droid-text outline-none placeholder:text-droid-text-muted/50"
            autoFocus
          />
          <textarea
            value={draft.prompt}
            onChange={(event) => update('prompt', event.target.value)}
            placeholder="Describe what DROIDEX should do"
            rows={5}
            className={`${CONTROL} resize-none leading-5`}
          />

          <SectionLabel>Details</SectionLabel>
          <div className="overflow-hidden rounded-2xl border border-droid-border bg-droid-surface/50">
            <EditorRow label="Runs on">
              <span className="text-droid-text-secondary">This device</span>
            </EditorRow>
            <EditorRow label="Workspace">
              <SelectControl
                value={draft.workspaceCwd ?? ''}
                onChange={(value) =>
                  onChange({
                    ...draft,
                    workspaceCwd: value || null,
                    executionMode: value ? draft.executionMode : 'local',
                  })
                }
                options={[
                  { value: '', label: 'No workspace' },
                  ...workspaceScopes.map((scope) => ({
                    value: scope.cwd,
                    label: workspaceLabel(scope.cwd),
                  })),
                ]}
              />
            </EditorRow>
            <EditorRow label="Runs in" last>
              <SelectControl
                value={draft.executionMode}
                disabled={!draft.workspaceCwd}
                onChange={(value) => update('executionMode', value as 'worktree' | 'local')}
                options={[
                  { value: 'local', label: 'Current workspace' },
                  { value: 'worktree', label: 'Isolated worktree' },
                ]}
              />
            </EditorRow>
          </div>

          <SectionLabel>Frequency</SectionLabel>
          <div className="overflow-hidden rounded-2xl border border-droid-border bg-droid-surface/50">
            <EditorRow label="Repeat">
              <SelectControl
                value={draft.schedule.kind}
                onChange={(value) => updateSchedule(scheduleForKind(value, draft.schedule))}
                options={[
                  { value: 'once', label: 'Once' },
                  { value: 'hourly', label: 'Hourly' },
                  { value: 'daily', label: 'Daily' },
                  { value: 'weekdays', label: 'Weekdays' },
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'cron', label: 'Custom cron' },
                ]}
              />
            </EditorRow>
            <ScheduleControls schedule={draft.schedule} onChange={updateSchedule} />
            <EditorRow label="Status" last>
              <SelectControl
                value={draft.enabled ? 'active' : 'paused'}
                onChange={(value) => update('enabled', value === 'active')}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'paused', label: 'Paused' },
                ]}
              />
            </EditorRow>
          </div>

          <p className="mt-3 text-[11px] leading-4 text-droid-text-muted">
            Saved locally on this device. This branch enables the automation workflow and design
            for review; scheduled execution is not enabled yet.
          </p>
        </div>

        <div className="border-t border-droid-border px-5 py-4">
          {validation && <p className="mb-2 text-[11px] text-droid-text-muted">{validation}</p>}
          <button
            type="button"
            onClick={onSave}
            disabled={Boolean(validation)}
            className="ml-auto block rounded-xl bg-droid-text px-4 py-2 text-[13px] font-medium text-droid-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
          >
            {editor.mode === 'create' ? 'Create' : 'Save changes'}
          </button>
        </div>
      </div>
    </aside>
  );
}

function ScheduleControls({
  schedule,
  onChange,
}: {
  schedule: AutomationSchedule;
  onChange: (schedule: AutomationSchedule) => void;
}) {
  switch (schedule.kind) {
    case 'once':
      return (
        <EditorRow label="At">
          <input
            type="datetime-local"
            value={toLocalDateTimeInput(schedule.runAt)}
            min={toLocalDateTimeInput(Date.now() + 60_000)}
            onChange={(event) => {
              const runAt = new Date(event.target.value).getTime();
              if (Number.isFinite(runAt)) onChange({ kind: 'once', runAt });
            }}
            className="max-w-[205px] bg-transparent text-right text-[13px] text-droid-text outline-none"
          />
        </EditorRow>
      );
    case 'hourly':
      return (
        <EditorRow label="At minute">
          <input
            type="number"
            min={0}
            max={59}
            value={schedule.minute}
            onChange={(event) =>
              onChange({ kind: 'hourly', minute: Number(event.target.value) })
            }
            className="w-16 rounded-lg border border-droid-border bg-droid-bg px-2 py-1.5 text-right text-[13px] text-droid-text outline-none"
          />
        </EditorRow>
      );
    case 'daily':
    case 'weekdays':
      return (
        <EditorRow label="At">
          <TimeInput
            value={schedule.time}
            onChange={(time) => onChange({ kind: schedule.kind, time })}
          />
        </EditorRow>
      );
    case 'weekly':
      return (
        <>
          <EditorRow label="On">
            <SelectControl
              value={String(schedule.weekday)}
              onChange={(value) =>
                onChange({ ...schedule, weekday: Number(value) })
              }
              options={WEEKDAYS.map((weekday, index) => ({
                value: String(index),
                label: weekday,
              }))}
            />
          </EditorRow>
          <EditorRow label="At">
            <TimeInput value={schedule.time} onChange={(time) => onChange({ ...schedule, time })} />
          </EditorRow>
        </>
      );
    case 'cron':
      return (
        <EditorRow label="Expression">
          <input
            value={schedule.expression}
            onChange={(event) => onChange({ kind: 'cron', expression: event.target.value })}
            placeholder="0 9 * * 1-5"
            className="w-[180px] rounded-lg border border-droid-border bg-droid-bg px-2.5 py-1.5 text-right font-mono text-[12px] text-droid-text outline-none placeholder:text-droid-text-muted/50"
          />
        </EditorRow>
      );
  }
}

function scheduleForKind(kind: string, current: AutomationSchedule): AutomationSchedule {
  const time = 'time' in current ? current.time : '09:00';
  switch (kind) {
    case 'once':
      return { kind: 'once', runAt: Date.now() + 60 * 60 * 1000 };
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

function TimeInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-transparent text-right text-[13px] text-droid-text outline-none"
    />
  );
}

function SectionLabel({ children }: { children: string }) {
  return <h3 className="mb-2 mt-6 text-[12px] font-medium text-droid-text-muted">{children}</h3>;
}

function EditorRow({
  label,
  children,
  last = false,
}: {
  label: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex min-h-11 items-center justify-between gap-4 px-3.5 py-2 text-[13px] ${
        last ? '' : 'border-b border-droid-border/70'
      }`}
    >
      <span className="shrink-0 text-droid-text-secondary">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function SelectControl({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`relative inline-flex max-w-[210px] items-center ${disabled ? 'opacity-40' : ''}`}>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[210px] appearance-none truncate bg-transparent py-1 pl-2 pr-5 text-right text-[13px] text-droid-text outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 h-3.5 w-3.5 text-droid-text-muted" />
    </label>
  );
}

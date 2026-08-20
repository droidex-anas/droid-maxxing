import {
  CalendarClock,
  CirclePause,
  CirclePlay,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { WorkspaceScope } from '../../lib/workspaces';
import { AutomationEditor } from './AutomationEditor';
import {
  automationToDraft,
  defaultAutomationDraft,
  formatNextRun,
  formatSchedule,
  nextAutomationRun,
  workspaceLabel,
} from './schedule';
import {
  loadAutomations,
  removeAutomation,
  saveAutomation,
  setAutomationEnabled,
} from './storage';
import type { Automation, AutomationDraft, AutomationEditorState } from './types';

interface AutomationsViewProps {
  workspaceScopes: readonly WorkspaceScope[];
  currentWorkspaceCwd: string | null;
  onChatWithDroidex: () => void;
}

type Filter = 'all' | 'active' | 'paused';

const SUGGESTIONS: readonly {
  title: string;
  detail: string;
  draft: Omit<AutomationDraft, 'workspaceCwd' | 'executionMode'>;
}[] = [
  {
    title: 'Daily repository brief',
    detail: 'Review recent changes, open pull requests, failing tests, and priorities.',
    draft: {
      title: 'Daily repository brief',
      prompt:
        'Review recent changes, open pull requests, failing tests, and unfinished work. Give me a concise brief with the most important next actions.',
      enabled: true,
      schedule: { kind: 'weekdays', time: '09:00' },
    },
  },
  {
    title: 'Weekly review',
    detail: 'Turn the week’s work into a clear progress summary every Friday.',
    draft: {
      title: 'Weekly review',
      prompt:
        'Review this week’s repository activity and chats. Summarize what shipped, what is still blocked, and what should be prioritized next week.',
      enabled: true,
      schedule: { kind: 'weekly', weekday: 5, time: '16:00' },
    },
  },
  {
    title: 'Follow-up monitor',
    detail: 'Check the workspace for unfinished follow-ups and flag what needs attention.',
    draft: {
      title: 'Follow-up monitor',
      prompt:
        'Review recent work for unresolved TODOs, failing checks, unanswered review comments, and other follow-ups. Only report items that need attention.',
      enabled: true,
      schedule: { kind: 'daily', time: '10:00' },
    },
  },
];

export function AutomationsView({
  workspaceScopes,
  currentWorkspaceCwd,
  onChatWithDroidex,
}: AutomationsViewProps) {
  const [automations, setAutomations] = useState<Automation[]>(loadAutomations);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<AutomationEditorState | null>(null);
  const defaultWorkspaceCwd = useMemo(() => {
    if (!currentWorkspaceCwd) return null;
    return (
      workspaceScopes.find((scope) => scope.executionCwds.includes(currentWorkspaceCwd))?.cwd ??
      currentWorkspaceCwd
    );
  }, [currentWorkspaceCwd, workspaceScopes]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return automations.filter((automation) => {
      if (filter === 'active' && !automation.enabled) return false;
      if (filter === 'paused' && automation.enabled) return false;
      if (!normalizedQuery) return true;
      return `${automation.title}\n${automation.prompt}\n${automation.workspaceCwd ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [automations, filter, query]);

  const createDraft = (draft = defaultAutomationDraft(defaultWorkspaceCwd)) => {
    setEditor({ mode: 'create', draft });
  };

  const saveEditor = () => {
    if (!editor) return;
    setAutomations(
      saveAutomation(automations, {
        existingId: editor.mode === 'edit' ? editor.automation.id : undefined,
        draft: editor.draft,
      }),
    );
    setEditor(null);
  };

  return (
    <div className="fixed bottom-0 left-[280px] right-0 top-0 z-[35] flex bg-droid-bg text-droid-text">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div data-electron-drag-region className="h-9" />
        <div className="mx-auto w-full max-w-[920px] px-8 pb-16 pt-12">
          <div className="flex items-start justify-between gap-6">
            <div>
              <h1 className="text-[28px] font-medium tracking-[-0.03em]">Automations</h1>
              <p className="mt-1 text-[14px] text-droid-text-muted">
                Schedule DROIDEX work with a lightweight, local-first workflow.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onChatWithDroidex}
                className="inline-flex items-center gap-2 rounded-xl border border-droid-border bg-droid-surface/50 px-3.5 py-2 text-[13px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
              >
                <MessageSquareText className="h-4 w-4" />
                Chat with DROIDEX
              </button>
              <button
                type="button"
                onClick={() => createDraft()}
                className="inline-flex items-center gap-2 rounded-xl bg-droid-text px-3.5 py-2 text-[13px] font-medium text-droid-bg"
              >
                <Plus className="h-4 w-4" />
                Create
              </button>
            </div>
          </div>

          <label className="mt-8 flex h-10 items-center gap-2 rounded-xl border border-droid-border bg-droid-surface/40 px-3 text-droid-text-muted focus-within:border-droid-text-muted">
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search automations"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-droid-text outline-none placeholder:text-droid-text-muted/70"
            />
          </label>

          <div className="mt-5 flex items-center gap-1">
            {(['all', 'active', 'paused'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-lg px-3 py-1.5 text-[12px] capitalize transition-colors ${
                  filter === value
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:text-droid-text'
                }`}
              >
                {value}
              </button>
            ))}
          </div>

          <div className="mt-4 divide-y divide-droid-border/70 border-b border-droid-border/70">
            {visible.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                onEdit={() =>
                  setEditor({
                    mode: 'edit',
                    automation,
                    draft: automationToDraft(automation),
                  })
                }
                onToggle={() =>
                  setAutomations(
                    setAutomationEnabled(automations, automation.id, !automation.enabled),
                  )
                }
                onDelete={() => {
                  if (!window.confirm(`Delete “${automation.title}”?`)) return;
                  setAutomations(removeAutomation(automations, automation.id));
                  if (editor?.mode === 'edit' && editor.automation.id === automation.id) {
                    setEditor(null);
                  }
                }}
              />
            ))}
          </div>

          {visible.length === 0 && automations.length > 0 && (
            <div className="py-12 text-center text-[13px] text-droid-text-muted">
              No automations match this view.
            </div>
          )}

          {automations.length === 0 && (
            <section className="mt-8">
              <h2 className="text-[14px] font-medium text-droid-text-secondary">Suggestions</h2>
              <div className="mt-2 divide-y divide-droid-border/60">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion.title}
                    type="button"
                    onClick={() =>
                      createDraft({
                        ...suggestion.draft,
                        workspaceCwd: defaultWorkspaceCwd,
                        executionMode: 'local',
                      })
                    }
                    className="group flex w-full items-start gap-3 px-1 py-4 text-left"
                  >
                    <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-lg border border-droid-border bg-droid-surface text-droid-text-muted transition-colors group-hover:text-droid-text">
                      <CalendarClock className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-[13px] font-medium text-droid-text">
                        {suggestion.title}
                      </span>
                      <span className="mt-1 block text-[12px] leading-5 text-droid-text-muted">
                        {suggestion.detail}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      {editor && (
        <AutomationEditor
          editor={editor}
          workspaceScopes={workspaceScopes}
          onChange={(draft) => setEditor({ ...editor, draft })}
          onSave={saveEditor}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function AutomationRow({
  automation,
  onEdit,
  onToggle,
  onDelete,
}: {
  automation: Automation;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex min-h-[74px] items-center gap-3 px-1 py-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
          automation.enabled
            ? 'border-droid-border bg-droid-surface text-droid-text-secondary'
            : 'border-droid-border/70 text-droid-text-muted/50'
        }`}
      >
        {automation.enabled ? <CirclePlay className="h-3.5 w-3.5" /> : <CirclePause className="h-3.5 w-3.5" />}
      </span>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[13px] font-medium text-droid-text">{automation.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-droid-text-muted">
          <span>{formatSchedule(automation.schedule)}</span>
          <span aria-hidden>·</span>
          <span>{workspaceLabel(automation.workspaceCwd)}</span>
          <span aria-hidden>·</span>
          <span>
            {formatNextRun(
              automation.enabled ? nextAutomationRun(automation.schedule) : null,
              automation.completedAt,
            )}
          </span>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <RowAction label="Edit" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction label={automation.enabled ? 'Pause' : 'Resume'} onClick={onToggle}>
          {automation.enabled ? <CirclePause className="h-3.5 w-3.5" /> : <CirclePlay className="h-3.5 w-3.5" />}
        </RowAction>
        <RowAction label="Delete" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </RowAction>
      </div>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
    >
      {children}
    </button>
  );
}

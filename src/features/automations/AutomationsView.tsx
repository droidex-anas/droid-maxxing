import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Clock, LoaderCircle, MessageSquareText, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceScope } from '../../lib/workspaces';
import { toast } from '../../lib/toast';
import type { ModelInfo, ReasoningEffort } from '../../types/bridge';
import { AutomationEditor } from './AutomationEditor';
import { AutomationRow } from './AutomationRow';
import { automationModelSelectionIssue } from './modelSelection';
import type { AutomationEditorRequest } from '../../hooks/useStore';
import { AUTOMATION_SUGGESTIONS } from './suggestions';
import {
  createAutomation,
  deleteAutomation,
  requestAutomationSnapshot,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
  useAutomationSnapshot,
} from './client';
import {
  automationToDraft,
  defaultAutomationDraft,
  latestRunsByAutomation,
  resolveAutomationModelDefaults,
  validateAutomationDraft,
} from './schedule';
import type { Automation, AutomationDraft, AutomationEditorState } from './types';

interface AutomationsViewProps {
  workspaceScopes: readonly WorkspaceScope[];
  workspaceScopesReady: boolean;
  currentWorkspaceCwd: string | null;
  models: ModelInfo[];
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  onChatWithDroidex: () => void;
  onOpenSession: (appSessionId: string) => void;
  editorRequest: AutomationEditorRequest | null;
  onEditorRequestHandled: (requestId: number) => void;
}

type Filter = 'all' | 'active' | 'paused';

export function AutomationsView({
  workspaceScopes,
  workspaceScopesReady,
  currentWorkspaceCwd,
  models,
  defaultModelId,
  defaultReasoningEffort,
  onChatWithDroidex,
  onOpenSession,
  editorRequest,
  onEditorRequestHandled,
}: AutomationsViewProps) {
  const snapshot = useAutomationSnapshot();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<AutomationEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [followManualRun, setFollowManualRun] = useState<{
    automationId: string;
    requestedAfter: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    requestAutomationSnapshot();
  }, []);

  // Only live runs show second-level elapsed time; idle rows change at most once
  // a minute, so the idle tick stays cheap instead of re-rendering the list twice
  // a minute for nothing.
  useEffect(() => {
    setNow(Date.now());
    const active = snapshot.activeRunCount > 0 || snapshot.queuedRunCount > 0;
    const timer = window.setInterval(
      () => {
        setNow(Date.now());
      },
      active ? 1_000 : 60_000,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [snapshot.activeRunCount, snapshot.queuedRunCount]);

  useEffect(() => {
    if (!pendingDeleteId) return;
    const timer = window.setTimeout(() => {
      setPendingDeleteId(null);
    }, 4_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pendingDeleteId]);

  const defaultWorkspaceCwd = useMemo(() => {
    if (!currentWorkspaceCwd) return null;
    return (
      workspaceScopes.find((scope) => scope.executionCwds.includes(currentWorkspaceCwd))?.cwd ??
      currentWorkspaceCwd
    );
  }, [currentWorkspaceCwd, workspaceScopes]);
  const modelDefaults = useMemo(
    () => resolveAutomationModelDefaults(models, defaultModelId, defaultReasoningEffort),
    [defaultModelId, defaultReasoningEffort, models],
  );
  const latestRuns = useMemo(() => latestRunsByAutomation(snapshot.runs), [snapshot.runs]);

  // A proposal card can send the user here to edit one automation; the snapshot
  // may still be in flight when this mounts, so the request stays pending until
  // its automation appears (route changes clear it).
  useEffect(() => {
    if (!editorRequest) return;
    const automation = snapshot.automations.find(
      (candidate) => candidate.id === editorRequest.automationId,
    );
    if (!automation) return;
    editAutomationFromRequest(automation, modelDefaults, setEditor);
    onEditorRequestHandled(editorRequest.requestId);
  }, [editorRequest, modelDefaults, onEditorRequestHandled, snapshot.automations]);

  useEffect(() => {
    if (!followManualRun) return;
    const run = snapshot.runs
      .filter(
        (candidate) =>
          candidate.automationId === followManualRun.automationId &&
          candidate.trigger === 'manual' &&
          candidate.requestedAt >= followManualRun.requestedAfter,
      )
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .at(0);
    if (!run) return;
    if (run.appSessionId) {
      setFollowManualRun(null);
      onOpenSession(run.appSessionId);
      return;
    }
    if (run.status === 'failed') {
      setFollowManualRun(null);
      toast.error(run.error ?? 'The automation could not start.');
    }
  }, [followManualRun, onOpenSession, snapshot.runs]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return snapshot.automations.filter((automation) => {
      if (filter === 'active' && !automation.enabled) return false;
      if (filter === 'paused' && automation.enabled) return false;
      if (!normalizedQuery) return true;
      return `${automation.title}\n${automation.prompt}\n${automation.workspaceCwd ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [filter, query, snapshot.automations]);

  const createDraft = (patch?: Partial<AutomationDraft>) => {
    setEditor({
      mode: 'create',
      draft: {
        ...defaultAutomationDraft(
          defaultWorkspaceCwd,
          modelDefaults.modelId,
          modelDefaults.reasoningEffort,
        ),
        ...patch,
      },
    });
  };

  const editAutomation = (automation: Automation) => {
    const draft = automationToDraft(automation);
    setEditor({
      mode: 'edit',
      automation,
      draft: {
        ...draft,
        modelId: draft.modelId ?? modelDefaults.modelId,
        reasoningEffort: draft.reasoningEffort ?? modelDefaults.reasoningEffort,
      },
    });
  };

  const saveEditor = async () => {
    if (!editor || saving) return;
    // Time-dependent rules (a one-time run that has since passed) can go stale
    // while the drawer stays open, so the draft is checked again before writing.
    const issue = validateAutomationDraft(editor.draft, models);
    if (issue) {
      toast.error(issue);
      return;
    }
    setSaving(true);
    try {
      if (editor.mode === 'create') await createAutomation(editor.draft);
      else {
        await updateAutomation(editor.automation.id, editor.draft);
      }
      setEditor(null);
      toast.success(editor.mode === 'create' ? 'Automation created.' : 'Automation updated.');
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (automation: Automation) => {
    if (pendingDeleteId !== automation.id) {
      setPendingDeleteId(automation.id);
      return;
    }
    try {
      await deleteAutomation(automation.id);
      setPendingDeleteId(null);
      if (editor?.mode === 'edit' && editor.automation.id === automation.id) setEditor(null);
      toast.success('Automation deleted.');
    } catch (error) {
      showError(error);
    }
  };

  const statusSummary = [
    snapshot.activeRunCount ? `${String(snapshot.activeRunCount)} running` : '',
    snapshot.queuedRunCount ? `${String(snapshot.queuedRunCount)} queued` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      data-testid="automations-workspace"
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-droid-bg text-droid-text"
    >
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div data-electron-drag-region className="h-9" />
        <div className="mx-auto w-full max-w-[980px] px-8 pb-16 pt-12">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-[28px] font-medium tracking-[-0.03em]">Automations</h1>
                {statusSummary && (
                  <span className="rounded-full border border-droid-border bg-droid-surface/60 px-2 py-1 text-[10.5px] text-droid-text-muted">
                    {statusSummary}
                  </span>
                )}
              </div>
              <p className="mt-1 max-w-[660px] text-[14px] leading-5 text-droid-text-muted">
                Schedule tasks and automations to run through DROIDEX on the model, workspace, and
                timezone you choose.
              </p>
              <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-droid-text-muted/75">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    snapshot.scheduler.ready ? 'bg-droid-accent/70' : 'bg-droid-text-muted/35'
                  }`}
                />
                <span>
                  {schedulerStatus(snapshot.scheduler.nextWakeAt, snapshot.scheduler.ready)}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onChatWithDroidex}
                className="inline-flex items-center gap-2 rounded-xl border border-droid-border bg-droid-surface/50 px-3.5 py-2 text-[13px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:bg-droid-elevated hover:text-droid-text"
              >
                <MessageSquareText className="h-4 w-4" />
                Chat with DROIDEX
              </button>
              <button
                type="button"
                onClick={() => {
                  createDraft();
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-droid-text px-3.5 py-2 text-[13px] font-medium text-droid-bg transition-opacity hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                Create automation
              </button>
            </div>
          </div>

          <label className="mt-8 flex h-10 items-center gap-2 rounded-xl border border-droid-border bg-droid-surface/40 px-3 text-droid-text-muted transition-colors focus-within:border-droid-border-hover focus-within:bg-droid-surface/55">
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={query}
              aria-label="Search automations"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search automations"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-droid-text outline-none placeholder:text-droid-text-muted/70"
            />
          </label>

          <div className="mt-5 flex items-center gap-1">
            {(['all', 'active', 'paused'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setFilter(value);
                }}
                className={`rounded-lg px-3 py-1.5 text-[12px] capitalize transition-colors ${
                  filter === value
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:bg-droid-elevated/50 hover:text-droid-text'
                }`}
              >
                {value}
              </button>
            ))}
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-droid-border/80 bg-droid-surface/20">
            {visible.map((automation, index) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                run={latestRuns.get(automation.id)}
                model={models.find((candidate) => candidate.id === automation.modelId)}
                modelIssue={automationModelSelectionIssue(
                  models,
                  automation.modelId,
                  automation.reasoningEffort,
                )}
                now={now}
                deleteArmed={pendingDeleteId === automation.id}
                last={index === visible.length - 1}
                onEdit={() => {
                  editAutomation(automation);
                }}
                onToggle={() =>
                  void setAutomationEnabled(automation.id, !automation.enabled).catch(showError)
                }
                onRun={() => {
                  const requestedAfter = Date.now() - 250;
                  setFollowManualRun({ automationId: automation.id, requestedAfter });
                  void runAutomationNow(automation.id)
                    .then(() => toast.success('Starting automation…'))
                    .catch((error: unknown) => {
                      setFollowManualRun(null);
                      showError(error);
                    });
                }}
                onOpenSession={onOpenSession}
                onDelete={() => void deleteRow(automation)}
              />
            ))}
          </div>

          {visible.length === 0 && snapshot.automations.length > 0 && (
            <div className="py-12 text-center text-[13px] text-droid-text-muted">
              No automations match this view.
            </div>
          )}

          {snapshot.scheduler.ready && snapshot.automations.length === 0 && (
            <section className="mt-8">
              <h2 className="text-[14px] font-medium text-droid-text-secondary">Suggestions</h2>
              <div className="mt-2 overflow-hidden rounded-2xl border border-droid-border/75 bg-droid-surface/20">
                {AUTOMATION_SUGGESTIONS.map((suggestion, index) => (
                  <button
                    key={suggestion.title}
                    type="button"
                    onClick={() => {
                      createDraft(suggestion.draft);
                    }}
                    className={`group flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-droid-elevated/45 ${
                      index === AUTOMATION_SUGGESTIONS.length - 1
                        ? ''
                        : 'border-b border-droid-border/60'
                    }`}
                  >
                    <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-xl border border-droid-border bg-droid-surface text-droid-text-muted transition-colors group-hover:text-droid-text">
                      <Clock className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-[13px] font-medium text-droid-text">
                        {suggestion.title}
                      </span>
                      <span className="mt-1 block text-[12px] leading-5 text-droid-text-muted">
                        {suggestion.detail}
                      </span>
                    </span>
                    <Plus className="mt-1 h-4 w-4 text-droid-text-muted/65 transition-colors group-hover:text-droid-text" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      <AnimatePresence initial={false}>
        {editor && (
          <motion.div
            key="automation-editor"
            initial={reduceMotion ? { opacity: 1 } : { x: 28, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { x: 24, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-y-0 right-0 z-20 w-[410px]"
          >
            <AutomationEditor
              editor={editor}
              workspaceScopes={workspaceScopes}
              workspaceScopesReady={workspaceScopesReady}
              models={models}
              onChange={(draft) => {
                setEditor((current) => (current ? { ...current, draft } : current));
              }}
              onSave={() => void saveEditor()}
              onClose={() => {
                setEditor(null);
              }}
            />
            {saving && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-droid-bg/30 backdrop-blur-[1px]">
                <LoaderCircle className="h-5 w-5 animate-spin text-droid-text-muted" />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function editAutomationFromRequest(
  automation: Automation,
  defaults: { modelId: string | null; reasoningEffort: ReasoningEffort | null },
  setEditor: (state: AutomationEditorState) => void,
) {
  const draft = automationToDraft(automation);
  setEditor({
    mode: 'edit',
    automation,
    draft: {
      ...draft,
      modelId: draft.modelId ?? defaults.modelId,
      reasoningEffort: draft.reasoningEffort ?? defaults.reasoningEffort,
    },
  });
}

function schedulerStatus(nextWakeAt: number | null, ready: boolean): string {
  if (!ready) return 'Scheduler reconnecting';
  if (nextWakeAt === null) return 'Scheduler active · no upcoming runs';
  return `Scheduler active · next wake ${new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(nextWakeAt)}`;
}

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : 'Automation request failed.');
}

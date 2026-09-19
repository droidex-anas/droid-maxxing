import { useState, type ReactNode } from 'react';
import { MessageCirclePlus, Plus, RefreshCw } from 'lucide-react';
import { useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { createProject, refreshProjects, spawnThread, useProjects } from './client';
import { NewThreadForm } from './NewThreadForm';
import { ProjectPanel } from './ProjectPanel';
import { projectSession } from './sessions';
import type { ThreadInput } from './types';

export function ProjectsRoute() {
  const snapshot = useProjects();
  const dispatch = useStoreDispatch();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ ownerId?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const owner = useStoreSelector((state) => projectSession(state.sessions, form?.ownerId));
  const cwd = useStoreSelector(
    (state) => projectSession(state.sessions, state.activeAppSessionId)?.cwd ?? '',
  );
  const project =
    snapshot.projects.find((item) => item.id === selectedId) ?? snapshot.projects.at(0);

  function openThread(appSessionId: string): void {
    // Ordinary navigation preserves Review, diffs, browser and session controls.
    dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
  }

  async function submit(input: ThreadInput): Promise<void> {
    setPending(true);
    try {
      if (form?.ownerId) {
        if (!owner) throw new Error('The owning conversation is no longer available.');
        const selection = { ...input };
        delete selection.cwd;
        openThread(await spawnThread(form.ownerId, selection));
      } else {
        setSelectedId(await createProject(input));
      }
      setForm(null);
    } finally {
      setPending(false);
    }
  }

  let content: ReactNode = (
    <Empty
      loading={snapshot.loading}
      failed={Boolean(snapshot.error)}
      onCreate={() => {
        setForm({});
      }}
    />
  );
  if (project) {
    content = (
      <ProjectPanel
        key={project.id}
        project={project}
        onOpen={openThread}
        onSpawn={(ownerId) => {
          setForm({ ownerId });
        }}
      />
    );
  }
  if (form) {
    content = (
      <div className="overflow-auto px-6 py-8">
        <NewThreadForm
          key={form.ownerId ?? 'new'}
          owner={owner}
          cwd={cwd}
          onSubmit={submit}
          onCancel={() => {
            setForm(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-droid-bg text-droid-text">
      <div data-electron-drag-region className="h-9 shrink-0" />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Projects"
          className="w-[236px] shrink-0 overflow-auto border-r border-droid-border/60 px-3 py-3"
        >
          <div className="mb-3 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-droid-text-muted">Projects</span>
            <button
              type="button"
              aria-label="New project"
              disabled={pending}
              onClick={() => {
                setForm({});
              }}
              className="rounded-lg p-1.5 text-droid-text-secondary hover:bg-droid-elevated focus-visible:ring-2 focus-visible:ring-droid-text-muted"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="space-y-1">
            {snapshot.projects.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={pending}
                onClick={() => {
                  setSelectedId(item.id);
                  setForm(null);
                }}
                aria-current={project?.id === item.id ? 'page' : undefined}
                className={`w-full rounded-xl px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-droid-text-muted ${project?.id === item.id && !form ? 'bg-droid-active' : 'hover:bg-droid-elevated'}`}
              >
                <div className="truncate text-[13px] font-medium">{item.title}</div>
                <div className="mt-0.5 text-[10px] text-droid-text-muted">
                  {item.threads.length} threads{item.paused ? ' · Paused' : ''}
                </div>
              </button>
            ))}
          </div>
        </aside>
        <section aria-label="Project workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {snapshot.error && (
            <div
              role="alert"
              className="flex items-center gap-3 border-b border-droid-border/50 px-6 py-3 text-xs text-droid-text-secondary"
            >
              <span className="flex-1">{snapshot.error}</span>
              <button
                type="button"
                onClick={refreshProjects}
                className="rounded-lg p-1.5 hover:bg-droid-elevated"
                aria-label="Reload projects"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          )}
          {content}
        </section>
      </div>
    </div>
  );
}

function Empty({
  loading,
  failed,
  onCreate,
}: {
  loading: boolean;
  failed: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 pt-24 text-center">
      <div className="mb-4 rounded-2xl border border-droid-border/60 bg-droid-elevated/40 p-3">
        <MessageCirclePlus size={20} className="text-droid-text-secondary" />
      </div>
      <h1 className="text-[20px] font-semibold tracking-tight">
        {loading ? 'Loading projects…' : 'Projects'}
      </h1>
      <p className="mt-2 text-[12px] leading-5 text-droid-text-muted">
        Independent conversations, one local workspace. Each thread keeps its own history.
      </p>
      {!loading && !failed && (
        <button
          type="button"
          onClick={onCreate}
          className="mt-5 rounded-xl bg-droid-text px-4 py-2 text-xs font-medium text-droid-bg"
        >
          Create project
        </button>
      )}
    </div>
  );
}

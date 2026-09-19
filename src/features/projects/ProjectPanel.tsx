import { useState } from 'react';
import { pauseProject, stopThread } from './client';
import { ProjectThreadCard } from './ProjectThreadCard';
import type { ProjectView } from './types';

export function ProjectPanel({
  project,
  onOpen,
  onSpawn,
}: {
  project: ProjectView;
  onOpen: (appSessionId: string) => void;
  onSpawn: (appSessionId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const root = project.threads.find((thread) => !thread.ownerAppSessionId);
  const shownError = error || project.error;
  let pauseLabel = project.paused ? 'Resume coordination' : 'Pause coordination';
  if (pending) pauseLabel = 'Saving…';
  const cannotResume = project.paused && project.uncertain > 0 && !reviewed;

  async function togglePaused(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await pauseProject(project.id, !project.paused, reviewed);
      setReviewed(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  async function stop(target: string): Promise<void> {
    if (!root || pending) return;
    setPending(true);
    setError('');
    try {
      await stopThread(root.appSessionId, target);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <header className="shrink-0 border-b border-droid-border/50 px-6 pb-4 pt-3">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate text-[20px] font-semibold tracking-tight">
            {project.title}
          </h1>
          <button
            type="button"
            disabled={pending || cannotResume}
            onClick={() => void togglePaused()}
            className="rounded-xl border border-droid-border/60 px-3 py-1.5 text-xs text-droid-text-secondary hover:bg-droid-elevated disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-droid-text-muted"
          >
            {pauseLabel}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-droid-text-muted">
          <span>{project.threads.length} threads</span>
          <span>{project.queued} queued messages</span>
          <span>{project.wakesLeft} automatic wakes left</span>
          {project.launching > 0 && <span>Starting threads…</span>}
        </div>
        {shownError && (
          <p role="alert" className="mt-3 text-xs leading-5 text-droid-text-secondary">
            {shownError}
          </p>
        )}
        {project.uncertain > 0 && (
          <div className="mt-3 rounded-xl border border-droid-border/60 p-3 text-xs text-droid-text-secondary">
            <p>
              A previous wake may already have reached its conversation. It will not be sent again
              automatically.
            </p>
            <div className="my-2 flex flex-wrap gap-2">
              {project.uncertainTargets.map((id) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => {
                    onOpen(id);
                  }}
                  className="rounded-lg bg-droid-elevated px-2 py-1"
                >
                  Review{' '}
                  {project.threads.find((thread) => thread.appSessionId === id)?.title ?? 'thread'}
                </button>
              ))}
            </div>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => {
                  setReviewed(event.target.checked);
                }}
              />
              I reviewed these conversations. Discard the uncertain wake without resending it.
            </label>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <p className="mb-5 text-[11px] leading-5 text-droid-text-muted">
          This draft supports the controls below. Agent-native thread tools are not connected yet;
          no MCP server is added.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {project.threads.map((thread) => (
            <ProjectThreadCard
              key={thread.appSessionId}
              thread={thread}
              busy={pending}
              ownerTitle={
                project.threads.find((item) => item.appSessionId === thread.ownerAppSessionId)
                  ?.title
              }
              disabled={
                project.paused || pending || project.threads.length + project.launching >= 8
              }
              onOpen={() => {
                onOpen(thread.appSessionId);
              }}
              onSpawn={() => {
                onSpawn(thread.appSessionId);
              }}
              onStop={() => void stop(thread.appSessionId)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

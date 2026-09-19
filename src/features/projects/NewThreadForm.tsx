import { useState, type SyntheticEvent } from 'react';
import { ArrowUp, FolderOpen } from 'lucide-react';
import { pickDirectory } from '../../lib/desktop';
import type { SessionSummary } from '../../types/bridge';
import { ThreadSettings } from './ThreadSettings';
import { buildThreadInput, useThreadSelection } from './useThreadSelection';
import type { ThreadInput } from './types';

export function NewThreadForm({
  owner,
  cwd,
  onSubmit,
  onCancel,
}: {
  owner?: SessionSummary;
  cwd: string;
  onSubmit: (input: ThreadInput) => Promise<void>;
  onCancel: () => void;
}) {
  const selection = useThreadSelection(owner);
  const [draft, setDraft] = useState({ title: '', prompt: '', workspace: cwd });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const unavailable = selection.catalog.unavailable;
  const blocked = pending || !draft.prompt.trim() || Boolean(unavailable);
  const submitLabel = owner ? 'Start thread' : 'Create project';
  const shownError = error || unavailable;

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (blocked) return;
    setPending(true);
    setError('');
    try {
      await onSubmit(buildThreadInput(draft, selection.value, selection.catalog));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  async function chooseFolder(): Promise<void> {
    try {
      const workspace = await pickDirectory();
      if (workspace) setDraft((current) => ({ ...current, workspace }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mx-auto w-full max-w-2xl rounded-2xl border border-droid-border/60 bg-droid-elevated/25 p-5"
    >
      <h2 className="mb-1 text-lg font-medium tracking-tight">
        {owner ? 'New thread' : 'New project'}
      </h2>
      <p className="mb-5 text-xs text-droid-text-muted">
        {owner
          ? `Managed by ${owner.title}`
          : 'Start a main conversation, then add independent threads.'}
      </p>
      <label className="block text-xs text-droid-text-secondary">
        Name
        <input
          value={draft.title}
          onChange={(event) => {
            setDraft({ ...draft, title: event.target.value });
          }}
          disabled={pending}
          maxLength={120}
          placeholder="Optional short name"
          className="mt-1 mb-4 w-full rounded-xl border border-droid-border/50 bg-droid-bg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-droid-text-muted"
        />
      </label>
      <label className="block text-xs text-droid-text-secondary">
        Task
        <textarea
          value={draft.prompt}
          onChange={(event) => {
            setDraft({ ...draft, prompt: event.target.value });
          }}
          disabled={pending}
          maxLength={8_192}
          required
          rows={5}
          placeholder="Describe the work for this conversation."
          className="mt-1 w-full resize-y rounded-xl border border-droid-border/50 bg-droid-bg px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-droid-text-muted"
        />
      </label>
      <ThreadSettings
        value={selection.value}
        catalog={selection.catalog}
        disabled={pending}
        onChange={selection.setValue}
      />
      {!owner && (
        <label className="mb-4 block text-xs text-droid-text-secondary">
          Workspace
          <div className="mt-1 flex gap-2">
            <input
              value={draft.workspace}
              onChange={(event) => {
                setDraft({ ...draft, workspace: event.target.value });
              }}
              disabled={pending}
              maxLength={4_096}
              placeholder="Optional absolute folder path"
              className="min-w-0 flex-1 rounded-xl border border-droid-border/50 bg-droid-bg px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-droid-text-muted"
            />
            <button
              type="button"
              aria-label="Choose workspace folder"
              disabled={pending}
              onClick={() => void chooseFolder()}
              className="rounded-xl px-3 hover:bg-droid-elevated focus-visible:ring-2 focus-visible:ring-droid-text-muted"
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </label>
      )}
      {shownError && (
        <p role="alert" className="mb-3 text-xs leading-5 text-droid-text-secondary">
          {shownError}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-droid-border/50 pt-4">
        <button
          type="button"
          disabled={pending}
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-xs text-droid-text-muted hover:bg-droid-elevated focus-visible:ring-2 focus-visible:ring-droid-text-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={blocked}
          className="flex items-center gap-2 rounded-xl bg-droid-text px-3 py-2 text-xs font-medium text-droid-bg transition-opacity hover:opacity-80 disabled:opacity-40"
        >
          {pending ? 'Starting…' : submitLabel}
          <ArrowUp size={14} />
        </button>
      </div>
    </form>
  );
}

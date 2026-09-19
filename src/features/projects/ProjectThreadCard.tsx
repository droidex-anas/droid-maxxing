import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, GitBranch, Plus, Square } from 'lucide-react';
import { shallowEqual, useStoreSelector } from '../../hooks/useStore';
import { projectSession } from './sessions';
import type { ProjectThread } from './types';

export function ProjectThreadCard({
  thread,
  ownerTitle,
  disabled,
  busy,
  onOpen,
  onSpawn,
  onStop,
}: {
  thread: ProjectThread;
  ownerTitle?: string;
  disabled: boolean;
  busy: boolean;
  onOpen: () => void;
  onSpawn: () => void;
  onStop: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const state = useStoreSelector((store) => {
    const session = projectSession(store.sessions, thread.appSessionId);
    return {
      provider: session?.provider,
      model: session?.modelId,
      reasoning: session?.reasoningEffort,
      autonomy: session?.autonomy,
      phase: session?.phase,
      streaming: session?.streaming,
      needsUser:
        Object.hasOwn(store.pendingPermissions, thread.appSessionId) ||
        Object.hasOwn(store.pendingQuestions, thread.appSessionId),
    };
  }, shallowEqual);
  let status = 'Idle';
  if (state.phase === 'paused') status = 'Paused';
  if (state.phase === 'failed') status = 'Failed';
  if (state.streaming) status = 'Working';
  if (thread.waiting) status = 'Waiting for owner';
  if (state.needsUser) status = 'Needs you';
  const chips = [
    { key: 'harness', value: state.provider },
    { key: 'model', value: state.model },
    { key: 'reasoning', value: state.reasoning },
    { key: 'autonomy', value: state.autonomy },
  ];
  return (
    <motion.div
      layout={!reducedMotion}
      initial={false}
      transition={{ duration: reducedMotion ? 0 : 0.18 }}
      className="rounded-2xl border border-droid-border/60 bg-droid-elevated/25 p-4"
    >
      <div className="mb-2 flex items-center gap-2 text-[10px] text-droid-text-muted">
        <GitBranch size={12} />
        <span className="truncate">{ownerTitle ? `From ${ownerTitle}` : 'Main conversation'}</span>
        <span className="ml-auto shrink-0 rounded-full bg-droid-bg/70 px-2 py-0.5">{status}</span>
      </div>
      <button
        type="button"
        disabled={!state.provider || busy}
        onClick={onOpen}
        className="group flex w-full items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-droid-text-muted disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{thread.title}</span>
        <ArrowUpRight
          size={14}
          className="text-droid-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-droid-text-muted">
        {chips.map(
          (chip) =>
            chip.value && (
              <span
                key={chip.key}
                className="max-w-full truncate rounded-lg border border-droid-border/50 px-2 py-1"
              >
                {chip.value}
              </span>
            ),
        )}
        {!state.provider && <span>This saved conversation is unavailable.</span>}
      </div>
      <div className="mt-4 flex gap-2 border-t border-droid-border/40 pt-2">
        <button
          type="button"
          disabled={disabled || !state.provider}
          onClick={onSpawn}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-droid-text-muted"
        >
          <Plus size={12} />
          New thread
        </button>
        {ownerTitle && state.streaming && (
          <button
            type="button"
            disabled={busy}
            onClick={onStop}
            className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-droid-text-muted hover:bg-droid-elevated focus-visible:ring-2 focus-visible:ring-droid-text-muted"
          >
            <Square size={10} />
            Stop
          </button>
        )}
      </div>
    </motion.div>
  );
}

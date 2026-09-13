// Subagents section of the right context panel: one stable summary line — the
// agents' pixel-creature avatars beside a working/done rollup — that opens a
// popover listing every agent. The section's height never depends on how many
// agents exist, so spawning a wave never reflows the Context panel.
import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { ChildSessionInfo } from '../hooks/storeChildSession';
import type { ChildStatus, ModelInfo } from '../types/bridge';
import {
  childSessionMeta,
  isPendingChildPlaceholder,
  workingFirstChildSessions,
} from '../lib/childSessions';
import { AgentAvatar } from './AgentAvatar';
import { Popover } from './environment/Popover';
import { RowCaret, SectionHeader } from './environment/primitives';

// Avatars shown side by side on the summary line before a "+N" overflow count.
const STACK_LIMIT = 4;

// Same status vocabulary as the in-chat subagents dock.
const STATUS_LABEL: Record<ChildStatus, string> = {
  running: 'Working',
  pending: 'Awaiting status',
  paused: 'Idle',
  completed: 'Done',
};

function RowStatus({ status, queued }: { status: ChildStatus; queued?: boolean }) {
  // The shimmer sweep is the working signal — no spinner, no pulsing dot.
  if (queued) {
    return <span className="text-[11px] font-medium text-droid-text-muted">Queued</span>;
  }
  if (status === 'running') {
    return <span className="shimmer-text text-[11px] font-medium">Working</span>;
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-droid-text-muted">
      {status === 'completed' && <Check className="h-3 w-3" strokeWidth={3} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

// Named distinct from the chat dock's SubagentRow (stream rows with phase
// pills); this is the compact row the panel's popover lists.
export function SubagentPanelRow({
  child,
  label,
  seed,
  models,
  selected,
  onSelect,
}: {
  child: ChildSessionInfo;
  label: string;
  seed: string;
  models: ModelInfo[];
  selected: boolean;
  onSelect: (child: ChildSessionInfo) => void;
}) {
  const model = models.find((m) => m.id === child.modelId);
  const displayedModel = model?.displayName
    ? `${model.displayName} (${child.modelId})`
    : child.modelId;
  const meta = childSessionMeta(child, displayedModel);
  return (
    <div
      data-testid="subagent-row"
      data-child-session-id={child.childSessionId}
      className={`group flex items-center rounded-lg transition-colors ${
        selected ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
      }`}
    >
      <button
        type="button"
        // A spawn the store has not registered yet has no session to open.
        disabled={isPendingChildPlaceholder(child)}
        onClick={() => {
          onSelect(child);
        }}
        title={`${meta}\nChild ID: ${child.childSessionId}${child.prompt ? `\n${child.prompt}` : ''}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <span className="shrink-0 transition-[filter] group-hover:brightness-125">
          <AgentAvatar
            seed={seed}
            size={16}
            working={child.status === 'running' && !child.queued}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={`truncate text-[13px] font-medium ${
              selected ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'
            }`}
          >
            {label}
          </span>
          {child.modelId && (
            <span className="truncate text-[11px] text-droid-text-muted">
              {displayedModel}
              {child.reasoningEffort ? ` · ${child.reasoningEffort}` : ''}
            </span>
          )}
        </span>
        <RowStatus status={child.status} queued={child.queued} />
      </button>
    </div>
  );
}

export function SubagentsSection({
  childSessions,
  models,
  selectedChildSessionId,
  onSelect,
}: {
  childSessions: ChildSessionInfo[];
  models: ModelInfo[];
  selectedChildSessionId: string | null;
  onSelect: (child: ChildSessionInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const ordered = workingFirstChildSessions(childSessions);
  const stack = ordered.slice(0, STACK_LIMIT);
  const overflow = ordered.length - stack.length;

  // The rollup on the summary line: working agents first, done count after.
  const workingCount = ordered.filter(
    ({ child }) => child.status === 'running' && !child.queued,
  ).length;
  const doneCount = ordered.filter(({ child }) => child.status === 'completed').length;

  return (
    <div>
      <SectionHeader label="Subagents" />
      <button
        ref={anchorRef}
        type="button"
        data-testid="subagents-summary"
        onClick={() => {
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
          open ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <span className="flex shrink-0 items-center gap-1">
          {stack.map(({ child, key }) => (
            <AgentAvatar
              key={key}
              seed={key}
              size={16}
              working={child.status === 'running' && !child.queued}
            />
          ))}
          {overflow > 0 && (
            <span className="text-[11px] font-medium tabular-nums text-droid-text-muted">
              +{overflow}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-droid-text-secondary">
          {workingCount > 0 && (
            <span className="shimmer-text font-medium text-droid-text">{workingCount} working</span>
          )}
          {workingCount > 0 && doneCount > 0 && (
            <span className="text-droid-text-muted/50"> · </span>
          )}
          {doneCount > 0 && <span>{doneCount} done</span>}
          {workingCount + doneCount === 0 && (
            <span>
              {ordered.length} {ordered.length === 1 ? 'agent' : 'agents'}
            </span>
          )}
        </span>
        <RowCaret open={open} />
      </button>

      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={anchorRef}
        label="Subagents"
        align="right"
        width={264}
      >
        <div className="max-h-72 overflow-y-auto p-1.5">
          {ordered.map(({ child, name, key }) => (
            <SubagentPanelRow
              key={key}
              child={child}
              label={name}
              seed={key}
              models={models}
              selected={child.childSessionId === selectedChildSessionId}
              onSelect={(picked) => {
                onSelect(picked);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </Popover>
    </div>
  );
}

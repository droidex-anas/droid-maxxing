import { memo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { ChildSessionSummary, ModelInfo } from '../types/bridge';
import { isPendingChildPlaceholder, type ChildSessionTarget } from '../lib/childSessions';
import {
  CHILD_STREAM_PHASE_LABEL,
  type ChildStreamPhase,
  type ChildStreamSnapshot,
} from '../lib/childSessionStream';
import { formatDuration } from '../lib/tools';
import { ModelIcon, providerOf } from './ModelIcon';
import { SubagentStreamPreview } from './SubagentStreamPreview';

export function subagentRowTitle(
  name: string,
  child: Pick<ChildSessionSummary, 'childSessionId'>,
): string {
  if (isPendingChildPlaceholder(child)) return `Open ${name} session`;
  return `Open ${name} session\nChild ID: ${child.childSessionId}`;
}

const PHASE_PILL: Record<ChildStreamPhase, string> = {
  queued: 'bg-droid-border/40 text-droid-text-secondary',
  starting: 'bg-droid-border/40 text-droid-text-secondary',
  streaming: 'bg-droid-green/15 text-droid-green',
  awaiting_approval: 'bg-droid-orange/15 text-droid-orange',
  settled: 'border border-droid-border text-droid-text-muted',
  failed: 'bg-red-500/15 text-red-400',
  interrupted: 'bg-droid-orange/15 text-droid-orange',
};

export interface SubagentRowProps {
  child: ChildSessionSummary;
  name: string;
  snapshot: ChildStreamSnapshot;
  model?: ModelInfo;
  durationMs?: number;
  target?: ChildSessionTarget;
  onOpen?: (target: ChildSessionTarget) => void;
}

export function areSubagentRowPropsEqual(
  previous: SubagentRowProps,
  next: SubagentRowProps,
): boolean {
  return (
    previous.snapshot === next.snapshot &&
    previous.name === next.name &&
    previous.durationMs === next.durationMs &&
    previous.model === next.model &&
    previous.onOpen === next.onOpen &&
    previous.child === next.child &&
    previous.target?.toolUseId === next.target?.toolUseId
  );
}

function childModelLine(
  child: Pick<ChildSessionSummary, 'modelId'>,
  model: ModelInfo | undefined,
): string {
  if (!child.modelId) return '';
  if (!model?.displayName) return child.modelId;
  return `${model.displayName} (${child.modelId})`;
}

function PhasePill({ phase }: { phase: ChildStreamPhase }) {
  return (
    <span
      data-testid="subagent-phase"
      data-phase={phase}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${PHASE_PILL[phase]}`}
    >
      {CHILD_STREAM_PHASE_LABEL[phase]}
    </span>
  );
}

export const SubagentRow = memo(function SubagentRow({
  child,
  name,
  snapshot,
  model,
  durationMs,
  target,
  onOpen,
}: SubagentRowProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const modelLine = childModelLine(child, model);
  const canOpen = Boolean(target && onOpen && !isPendingChildPlaceholder(child));
  const showPreview = Boolean(snapshot.preview) || snapshot.live;

  return (
    <motion.li
      data-testid="subagent-row"
      data-child-key={snapshot.key}
      variants={
        reduceMotion ? undefined : { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }
      }
    >
      <div className="rounded-lg px-2.5 py-2.5 transition-colors hover:bg-droid-active/40">
        <div className="flex w-full items-center gap-3">
          <span className="flex w-48 shrink-0 items-center gap-2.5">
            <ModelIcon provider={providerOf(model, child.modelId)} size={16} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium leading-4 text-droid-text">
                {name}
              </span>
              {modelLine ? (
                <span className="truncate text-[11px] leading-4 text-droid-text-muted">
                  {modelLine}
                </span>
              ) : null}
            </span>
            {child.reasoningEffort ? (
              <span className="shrink-0 rounded-md bg-droid-accent/15 px-1.5 py-0.5 text-[10px] font-medium capitalize text-droid-accent">
                {child.reasoningEffort}
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
            {CHILD_STREAM_PHASE_LABEL[snapshot.phase]}
          </span>
          <PhasePill phase={snapshot.phase} />
          <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-droid-text-muted">
            {durationMs != null ? formatDuration(durationMs) : ''}
          </span>
        </div>
        {showPreview ? (
          <div className="mt-2 pl-[26px]">
            <SubagentStreamPreview
              snapshot={snapshot}
              expanded={previewOpen}
              cacheId={`child-preview:${snapshot.key}`}
            />
            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen((open) => !open);
                }}
                aria-expanded={previewOpen}
                className="text-[12px] text-droid-text-muted transition-colors hover:text-droid-text"
              >
                {previewOpen ? 'Show less' : 'Show more'}
              </button>
              {canOpen ? (
                <button
                  type="button"
                  onClick={() => target && onOpen?.(target)}
                  title={subagentRowTitle(name, child)}
                  className="inline-flex items-center gap-1 text-[12px] text-droid-text-muted transition-colors hover:text-droid-text"
                >
                  Open transcript
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {!showPreview && canOpen ? (
          <button
            type="button"
            onClick={() => target && onOpen?.(target)}
            title={subagentRowTitle(name, child)}
            className="mt-1.5 inline-flex items-center gap-1 pl-[26px] text-[12px] text-droid-text-muted transition-colors hover:text-droid-text"
          >
            Open transcript
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </motion.li>
  );
}, areSubagentRowPropsEqual);

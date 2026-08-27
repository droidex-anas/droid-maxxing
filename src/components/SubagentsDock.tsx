import { useEffect, useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ChildSessionSummary, ChildStatus, ModelInfo } from '../types/bridge';
import {
  childSessionKey,
  childSessionLabel,
  orderedChildSessions,
  type ChildSessionActivity,
  type ChildSessionTarget,
} from '../lib/childSessions';
import { childStreamSnapshot, type ChildStreamSnapshot } from '../lib/childSessionStream';
import { useDocumentVisible } from '../hooks/useDocumentVisible';
import { formatDuration } from '../lib/tools';
import { SubagentRow, subagentRowTitle } from './SubagentRow';

export { subagentRowTitle };

/* One grouping card for a turn's subagent spawns, anchored where the first
   per-spawn feed line used to render. MessageFeed only renders it when the
   caller passes `subagentsDock`, so Mission Control keeps the inline lines.
   Expanding a large wave reveals the first rows behind a "Show N more
   subagents" fold, so paging older history into a long-running session never
   dumps dozens of rows (and their entrance stagger) at once. */

export const DOCK_VISIBLE_ROW_LIMIT = 8;

export function foldedDockRows<T>(rows: readonly T[], showAll: boolean): T[] {
  return showAll ? [...rows] : rows.slice(0, DOCK_VISIBLE_ROW_LIMIT);
}

export interface SubagentsDockData {
  sessions: ChildSessionSummary[];
  models: ModelInfo[];
  snapshots?: ReadonlyMap<string, ChildStreamSnapshot>;
}

interface SubagentsDockProps extends SubagentsDockData {
  // True only while this wave's turn is still streaming. It gates every ticking
  // clock: once the turn ends (or the user stops it) the card must stop counting
  // instead of accruing time forever against a run nobody is watching.
  live?: boolean;
  onOpen?: (target: ChildSessionTarget) => void;
  activity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
}

function resolveSubagentStatus(
  child: ChildSessionSummary,
  activity?: ChildSessionActivity,
): ChildStatus {
  return activity?.status ?? child.status;
}

function countSubagentStatuses(statuses: readonly ChildStatus[]): Record<ChildStatus, number> {
  const counts: Record<ChildStatus, number> = { pending: 0, running: 0, paused: 0, completed: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

const STATUS_ORDER: readonly ChildStatus[] = ['running', 'paused', 'pending', 'completed'];

const STATUS_META: Record<ChildStatus, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-droid-green/15 text-droid-green' },
  paused: { label: 'Awaiting approval', className: 'bg-droid-orange/15 text-droid-orange' },
  pending: { label: 'Awaiting status', className: 'bg-droid-border/40 text-droid-text-secondary' },
  completed: {
    label: 'Done',
    className: 'border border-droid-border text-droid-text-muted',
  },
};

const SEGMENT_TINT: Record<ChildStatus, string> = {
  running: 'bg-droid-green/40',
  paused: 'bg-droid-orange/40',
  pending: 'bg-droid-border/50',
  completed: 'bg-droid-green',
};

interface DockRow {
  child: ChildSessionSummary;
  status: ChildStatus;
  startedAt?: number;
  queued: boolean;
  snapshot: ChildStreamSnapshot;
  target?: ChildSessionTarget;
}

function buildRows(
  sessions: ChildSessionSummary[],
  activity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined,
  snapshots?: ReadonlyMap<string, ChildStreamSnapshot>,
): DockRow[] {
  return orderedChildSessions(sessions).map((child) => {
    const target: ChildSessionTarget | undefined =
      child.spawnLink?.kind === 'tool-use'
        ? {
            toolUseId: child.spawnLink.id,
            ...(child.label !== undefined ? { label: child.label } : {}),
          }
        : undefined;
    const resolved = target ? activity?.(target) : undefined;
    return {
      child,
      status: resolveSubagentStatus(child, resolved),
      startedAt: child.startedAt ?? resolved?.startedAt,
      queued: Boolean(child.queued),
      snapshot: snapshots?.get(childSessionKey(child)) ?? childStreamSnapshot(child, resolved),
      target,
    };
  });
}

function useNow(active: boolean): number {
  const visible = useDocumentVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active, visible]);
  return now;
}

function rowKey(row: DockRow): string {
  return row.target?.toolUseId ?? row.child.childSessionId;
}

function useRowDurationMs(rows: DockRow[], now: number, live: boolean): (number | undefined)[] {
  const [timings, setTimings] = useState<ReadonlyMap<string, { frozenMs?: number }>>(
    () => new Map(),
  );
  useEffect(() => {
    setTimings((prev) => {
      let next: Map<string, { frozenMs?: number }> | undefined;
      for (const row of rows) {
        const id = rowKey(row);
        const entry = prev.get(id);
        if (live && !row.queued && row.status !== 'completed' && row.status !== 'pending') {
          if (!entry) (next ??= new Map(prev)).set(id, {});
        } else if (entry && entry.frozenMs == null && row.startedAt != null) {
          (next ??= new Map(prev)).set(id, { frozenMs: Math.max(0, Date.now() - row.startedAt) });
        }
      }
      return next ?? prev;
    });
  }, [rows, live]);
  return rows.map((row) => {
    if (row.startedAt == null || row.queued || row.status === 'pending') return undefined;
    if (row.status === 'completed' || !live) {
      const entry = timings.get(rowKey(row));
      return entry ? (entry.frozenMs ?? Math.max(0, now - row.startedAt)) : undefined;
    }
    return row.status === 'running' ? Math.max(0, now - row.startedAt) : undefined;
  });
}

function StatusPill({
  status,
  count,
  className = '',
}: {
  status: ChildStatus | 'queued';
  count?: number;
  className?: string;
}) {
  const meta =
    status === 'queued'
      ? { label: 'Queued', className: 'bg-droid-border/40 text-droid-text-secondary' }
      : STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${meta.className} ${className}`}
    >
      {count != null ? `${String(count)} ` : ''}
      {meta.label}
    </span>
  );
}

export function SubagentsDock({
  sessions,
  models,
  snapshots,
  live = false,
  onOpen,
  activity,
}: SubagentsDockProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);
  const reduceMotion = useReducedMotion();
  const bodyId = useId();

  const rows = buildRows(sessions, activity, snapshots);
  const queuedCount = rows.filter((row) => row.queued).length;
  const counts = countSubagentStatuses(rows.filter((row) => !row.queued).map((row) => row.status));
  const unsettled = counts.running + counts.pending + queuedCount;
  const hasConfirmedRunning = counts.running > 0;
  const now = useNow(live && hasConfirmedRunning);
  const durationMs = useRowDurationMs(rows, now, live);
  const visibleRows = foldedDockRows(rows, showAllRows);
  const foldedRowCount = rows.length - visibleRows.length;

  if (rows.length === 0) return null;

  const allDone = counts.completed === rows.length && queuedCount === 0;
  const inFlight = live && unsettled > 0;
  const showRows = expanded || inFlight;
  const started = rows.map((row) => row.startedAt).filter((t): t is number => t != null);
  const firstStartedAt = started.length > 0 ? Math.min(...started) : undefined;
  const lastSettledAt = rows.reduce<number | undefined>((last, row, i) => {
    const ms = durationMs[i];
    if (row.startedAt == null || ms == null) return last;
    const settledAt = row.startedAt + ms;
    return last == null || settledAt > last ? settledAt : last;
  }, undefined);
  const timeMs =
    firstStartedAt == null || (inFlight && !hasConfirmedRunning)
      ? undefined
      : inFlight
        ? Math.max(0, now - firstStartedAt)
        : lastSettledAt != null
          ? Math.max(0, lastSettledAt - firstStartedAt)
          : undefined;
  const progress = counts.completed / rows.length;
  const plural = rows.length === 1 ? 'subagent' : 'subagents';
  const headerMeta = allDone
    ? `All ${String(rows.length)} ${plural} finished`
    : inFlight && counts.running === 0 && queuedCount > 0
      ? `${String(queuedCount)} ${queuedCount === 1 ? 'subagent' : 'subagents'} queued`
      : inFlight && counts.running === 0
        ? `Awaiting status for ${String(counts.pending)} ${counts.pending === 1 ? 'subagent' : 'subagents'}`
        : `${String(counts.completed)} of ${String(rows.length)} ${plural} finished`;

  const bodyTransition = reduceMotion
    ? { duration: 0.15 }
    : { type: 'spring' as const, stiffness: 320, damping: 27, mass: 0.9 };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') setExpanded(false);
      }}
      className="w-full overflow-hidden rounded-[20px] border border-droid-border bg-droid-surface shadow-[0_10px_30px_rgba(0,0,0,0.30)] transition-colors hover:border-droid-border-hover"
    >
      <button
        type="button"
        onClick={() => {
          setExpanded((value) => !value);
        }}
        aria-expanded={showRows}
        aria-controls={bodyId}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <span className="text-[12.5px] font-medium text-droid-text-secondary">Subagents</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[11.5px] text-droid-text-muted">{headerMeta}</span>
          {timeMs != null && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-droid-text-secondary">
              {formatDuration(timeMs)}
            </span>
          )}
        </span>
      </button>
      <div className="flex items-center gap-2 px-4 pb-3 pt-0.5">
        {queuedCount > 0 && (
          <StatusPill status="queued" count={queuedCount} className="px-2.5 py-1 text-[11.5px]" />
        )}
        {STATUS_ORDER.map(
          (status) =>
            counts[status] > 0 && (
              <StatusPill
                key={status}
                status={status}
                count={counts[status]}
                className="px-2.5 py-1 text-[11.5px]"
              />
            ),
        )}
        <span className="ml-1 flex min-w-0 flex-1 items-center gap-1">
          {rows.map((row) => (
            <span
              key={rowKey(row)}
              className={`h-1.5 min-w-[3px] flex-1 rounded-full transition-colors duration-500 ${
                row.queued ? SEGMENT_TINT.pending : SEGMENT_TINT[row.status]
              }`}
            />
          ))}
        </span>
        <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-droid-text">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <AnimatePresence initial={false}>
        {showRows ? (
          <motion.div
            key="rows"
            id={bodyId}
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={bodyTransition}
            className="overflow-hidden"
          >
            <motion.ul
              initial={reduceMotion ? false : 'hidden'}
              animate="show"
              variants={{ show: { transition: { staggerChildren: 0.045 } } }}
              className="px-2 pb-1.5"
            >
              {visibleRows.map((row, i) => {
                const model = models.find((entry) => entry.id === row.child.modelId);
                return (
                  <SubagentRow
                    key={rowKey(row)}
                    child={row.child}
                    name={childSessionLabel(row.child, i)}
                    snapshot={row.snapshot}
                    {...(model !== undefined ? { model } : {})}
                    {...(durationMs[i] !== undefined ? { durationMs: durationMs[i] } : {})}
                    {...(row.target !== undefined ? { target: row.target } : {})}
                    {...(onOpen !== undefined ? { onOpen } : {})}
                  />
                );
              })}
            </motion.ul>
            {foldedRowCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setShowAllRows(true);
                }}
                className="w-full px-4 pb-3 pt-1 text-left text-[12px] text-droid-text-muted transition-colors hover:text-droid-text-secondary"
              >
                Show {foldedRowCount} more {foldedRowCount === 1 ? 'subagent' : 'subagents'}
              </button>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

import { memo, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TranscriptEvent } from '../../types/bridge';
import { childSessionInfo, formatDuration } from '../../lib/tools';
import {
  childSessionLatest,
  resolveWaveSessions,
  type ChildSessionActivity,
  type ChildSessionTarget,
} from '../../lib/childSessions';
import { SubagentsDock, type SubagentsDockData } from '../SubagentsDock';
import { sameFeedEvents, type FeedItem } from '../chatFeed';
import { Caret, Expand, useElapsed } from './primitives';

/* ── Per-agent name color: deterministic pick so each droid keeps one hue ── */
const CHILD_SESSION_COLORS = [
  '#e0a458',
  '#6ea8fe',
  '#5cc8a8',
  '#c58af9',
  '#e8728f',
  '#7bd88f',
  '#f0a06a',
  '#9d8cff',
] as const;
function childSessionColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return CHILD_SESSION_COLORS[h % CHILD_SESSION_COLORS.length];
}

/* ── In-chat spawned child session: inline thinking-style line + click to navigate ── */
export function ChildSessionLine({
  event,
  onOpen,
  activity,
}: {
  event: TranscriptEvent;
  onOpen?: (target: ChildSessionTarget) => void;
  activity?: ChildSessionActivity;
}) {
  const [open, setOpen] = useState(false);
  const { label, description } = childSessionInfo(event.toolArgs);
  const name = label ?? 'child session';
  const color = childSessionColor(name);
  const running = childSessionLineIsRunning(activity);
  const startTs = activity?.startedAt;
  const elapsed = useElapsed(startTs, running);
  const timer = running && startTs != null && elapsed >= 1000 ? formatDuration(elapsed) : '';
  const verb = running ? 'Running' : 'Spawned';
  // Append the literal "child session" only when the name is a real droid label, so a
  // nameless spawn reads "Spawned child session" instead of "Spawned child session child session".
  const tail = [label ? 'child session' : '', timer].filter(Boolean).join(' ');
  const muted = running ? 'shimmer-text font-medium' : 'text-droid-text-muted';
  const latest = childSessionLatest(activity?.latest);
  const navigate = () => onOpen?.({ toolUseId: event.toolUseId, label });
  return (
    <div>
      <div className="group flex items-center gap-1.5 text-[13px]">
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="flex items-center"
          aria-label="Toggle child session activity"
          aria-expanded={open}
        >
          <Caret open={open} />
        </button>
        <span className={muted}>{verb}</span>
        <button
          type="button"
          onClick={navigate}
          className="font-semibold underline-offset-2 hover:underline"
          style={{ color }}
          title="Open child session session"
        >
          {name}
        </button>
        {tail && <span className={muted}>{tail}</span>}
      </div>
      <Expand open={open}>
        <div className="mt-2 pl-[18px]">
          {description && (
            <div className="text-[12.5px] text-droid-text-muted/70 leading-relaxed break-words">
              {description}
            </div>
          )}
          {latest && (
            <div className="mt-1.5 text-[12.5px] leading-relaxed break-words">
              <span
                className={
                  running ? 'shimmer-text font-medium' : 'text-droid-text-secondary font-medium'
                }
              >
                {latest.head}
              </span>
              {latest.body && (
                <span className="ml-1.5 text-[12px] text-droid-text-muted/80">{latest.body}</span>
              )}
            </div>
          )}
          {!latest && (
            <div className="mt-1.5 text-[12px] text-droid-text-muted/60">
              No activity captured yet.
            </div>
          )}
          <button
            type="button"
            onClick={navigate}
            className="mt-2 inline-flex items-center gap-1 text-[12px] text-droid-text-muted transition-colors hover:text-droid-text"
          >
            Open session
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </Expand>
    </div>
  );
}

export function childSessionLineIsRunning(activity?: ChildSessionActivity): boolean {
  return activity?.status === 'running';
}

// The feed rebuilds item objects on every streamed token, but an untouched
// wave's events keep their identity, so settled waves bail out of per-token
// re-renders. Live waves still update: the dock object changes identity when
// the store's child sessions or models change.
export const ChildSessionsWave = memo(
  function ChildSessionsWave({
    item,
    dock,
    live,
    onOpen,
    activity,
  }: {
    item: Extract<FeedItem, { type: 'child_sessions' }>;
    dock: SubagentsDockData;
    live?: boolean;
    onOpen?: (target: ChildSessionTarget) => void;
    activity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  }) {
    // Wave-scoped: resolve only this run's spawns so the card shows this
    // turn's agents, not the session's cumulative list.
    const sessions = useMemo(
      () => resolveWaveSessions(item.events, dock.sessions),
      [item.events, dock.sessions],
    );
    return (
      <SubagentsDock
        sessions={sessions}
        models={dock.models}
        live={live}
        onOpen={onOpen}
        activity={activity}
      />
    );
  },
  (prev, next) =>
    prev.dock === next.dock &&
    prev.live === next.live &&
    prev.onOpen === next.onOpen &&
    prev.activity === next.activity &&
    sameFeedEvents(prev.item, next.item),
);

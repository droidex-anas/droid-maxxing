import type { ChildSessionSummary, ChildStatus, TranscriptEvent } from '../types/bridge';
import { childSessionKey, childSessionLatest, type ChildSessionActivity } from './childSessions';

export const CHILD_STREAM_PREVIEW_MAX_LINES = 3;
export const CHILD_STREAM_PREVIEW_MAX_CHARS = 280;
export const CHILD_STREAM_PREVIEW_BOX_CLASS = 'min-h-[3.75rem] max-h-[3.75rem] overflow-hidden';
export const CHILD_STREAM_PREVIEW_EXPANDED_BOX_CLASS =
  'min-h-[3.75rem] max-h-[15rem] overflow-y-auto';

export type ChildStreamPhase =
  | 'queued'
  | 'starting'
  | 'streaming'
  | 'awaiting_approval'
  | 'settled'
  | 'failed'
  | 'interrupted';

export const CHILD_STREAM_PHASE_LABEL: Record<ChildStreamPhase, string> = {
  queued: 'Queued',
  starting: 'Starting',
  streaming: 'Streaming',
  awaiting_approval: 'Awaiting approval',
  settled: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export interface ChildStreamSnapshot {
  key: string;
  phase: ChildStreamPhase;
  preview: string;
  previewKind: 'markdown' | 'plain';
  live: boolean;
}

export function boundChildStreamPreview(
  text: string,
  maxLines = CHILD_STREAM_PREVIEW_MAX_LINES,
  maxChars = CHILD_STREAM_PREVIEW_MAX_CHARS,
): string {
  if (!text) return '';
  const lines = text.replace(/\s+$/u, '').split('\n');
  const tail = lines.slice(-Math.max(1, maxLines));
  const perLine = Math.max(32, Math.floor(maxChars / Math.max(tail.length, 1)));
  return tail
    .map((line) => (line.length <= perLine ? line : line.slice(line.length - perLine)))
    .join('\n');
}

export function childStreamPhase(input: {
  queued?: boolean;
  status?: ChildStatus;
  latestKind?: TranscriptEvent['kind'];
  isError?: boolean;
  hasOutput?: boolean;
  interruptReason?: string;
}): ChildStreamPhase {
  if (input.queued) return 'queued';
  const failed = input.isError === true || input.latestKind === 'error';
  if (input.status === 'completed') {
    if (failed) return 'failed';
    if (input.interruptReason) return 'interrupted';
    return 'settled';
  }
  if (input.interruptReason && input.status !== 'running') return 'interrupted';
  if (failed && input.status !== 'running') return 'failed';
  if (input.status === 'paused') return 'awaiting_approval';
  if (input.status === 'running') return input.hasOutput ? 'streaming' : 'starting';
  return 'starting';
}

export function sameChildStreamSnapshot(
  previous: ChildStreamSnapshot | undefined,
  next: ChildStreamSnapshot,
): boolean {
  return (
    previous !== undefined &&
    previous.key === next.key &&
    previous.phase === next.phase &&
    previous.preview === next.preview &&
    previous.previewKind === next.previewKind &&
    previous.live === next.live
  );
}

export function reuseChildStreamSnapshotMap(
  previous: ReadonlyMap<string, ChildStreamSnapshot> | undefined,
  next: ReadonlyMap<string, ChildStreamSnapshot>,
): ReadonlyMap<string, ChildStreamSnapshot> {
  if (!previous || previous.size !== next.size) return next;
  for (const [key, snapshot] of next) {
    if (previous.get(key) !== snapshot) return next;
  }
  return previous;
}

export function childStreamSnapshot(
  child: ChildSessionSummary,
  activity: ChildSessionActivity | undefined,
  interruptReason?: string,
): ChildStreamSnapshot {
  const status = child.queued ? child.status : (activity?.status ?? child.status);
  const latest = activity?.latest;
  const latestView = childSessionLatest(latest);
  const polled = child.activity;
  const rawPreview =
    latest?.kind === 'text' || latest?.kind === 'thinking' || latest?.kind === 'status'
      ? (latest.text ?? '')
      : (polled?.preview ?? '');
  const hasOutput = Boolean(
    rawPreview || latest?.toolName || latestView?.body || polled?.preview || polled?.phase,
  );
  const phase = childStreamPhase({
    queued: child.queued,
    status,
    latestKind: latest?.kind,
    isError: latest?.isError,
    hasOutput,
    ...(interruptReason !== undefined ? { interruptReason } : {}),
  });
  const markdown =
    phase === 'streaming' &&
    (latest?.kind === 'text' || latest?.kind === 'thinking' || latest?.kind === 'status');
  const previewSource = markdown
    ? rawPreview
    : (latestView?.body ?? polled?.preview ?? (phase === 'starting' ? (child.prompt ?? '') : ''));
  const live = phase === 'streaming' || phase === 'starting';
  return {
    key: childSessionKey(child),
    phase,
    preview: boundChildStreamPreview(previewSource),
    previewKind: markdown ? 'markdown' : 'plain',
    live,
  };
}

export function projectChildStreamSnapshots(
  children: readonly ChildSessionSummary[],
  activityFor: (child: ChildSessionSummary) => ChildSessionActivity | undefined,
  interruptReason?: string,
  previous?: ReadonlyMap<string, ChildStreamSnapshot>,
): ReadonlyMap<string, ChildStreamSnapshot> {
  const next = new Map<string, ChildStreamSnapshot>();
  for (const child of children) {
    const snapshot = childStreamSnapshot(child, activityFor(child), interruptReason);
    const prior = previous?.get(snapshot.key);
    next.set(snapshot.key, sameChildStreamSnapshot(prior, snapshot) && prior ? prior : snapshot);
  }
  return reuseChildStreamSnapshotMap(previous, next);
}

export function childStreamSnapshotsAreLive(
  snapshots: ReadonlyMap<string, ChildStreamSnapshot>,
): boolean {
  for (const snapshot of snapshots.values()) {
    if (snapshot.live || snapshot.phase === 'queued') return true;
  }
  return false;
}

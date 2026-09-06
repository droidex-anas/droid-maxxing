import type {
  ChildSessionSummary,
  ChildStatus,
  StreamFidelity,
  TranscriptEvent,
} from '../types/bridge';
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

export type ChildStreamPresentation = 'typewriter' | 'tool' | 'working' | 'idle';

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
  fidelity: StreamFidelity;
  step: string;
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

export function childStreamPhaseLabel(phase: ChildStreamPhase, fidelity: StreamFidelity): string {
  if (phase === 'streaming' && fidelity !== 'token') return 'Working';
  return CHILD_STREAM_PHASE_LABEL[phase];
}

export function childStreamPresentation(
  snapshot: Pick<ChildStreamSnapshot, 'live' | 'fidelity'>,
): ChildStreamPresentation {
  if (!snapshot.live) return 'idle';
  if (snapshot.fidelity === 'token') return 'typewriter';
  if (snapshot.fidelity === 'tool') return 'tool';
  return 'working';
}

export function childStreamShowsCaret(
  snapshot: Pick<ChildStreamSnapshot, 'live' | 'fidelity'>,
): boolean {
  return childStreamPresentation(snapshot) === 'typewriter';
}

export function sameChildStreamSnapshot(
  previous: ChildStreamSnapshot | undefined,
  next: ChildStreamSnapshot,
): boolean {
  if (previous === undefined) return false;
  return (
    previous.key === next.key &&
    previous.phase === next.phase &&
    previous.fidelity === next.fidelity &&
    previous.step === next.step &&
    previous.preview === next.preview &&
    previous.previewKind === next.previewKind &&
    previous.live === next.live
  );
}

export function reuseChildStreamSnapshotMap(
  previous: ReadonlyMap<string, ChildStreamSnapshot> | undefined,
  next: ReadonlyMap<string, ChildStreamSnapshot>,
): ReadonlyMap<string, ChildStreamSnapshot> {
  if (previous === undefined) return next;
  if (previous.size !== next.size) return next;
  for (const [key, snapshot] of next) {
    if (previous.get(key) !== snapshot) return next;
  }
  return previous;
}

function isTextLikeKind(kind: TranscriptEvent['kind'] | undefined): boolean {
  return kind === 'text' || kind === 'thinking' || kind === 'status';
}

function optionalText(value: string | undefined): string {
  return value ?? '';
}

function childStreamStatus(
  child: ChildSessionSummary,
  activity: ChildSessionActivity | undefined,
): ChildStatus {
  if (child.queued) return child.status;
  return activity?.status ?? child.status;
}

function childStreamRawPreview(
  latest: ChildSessionActivity['latest'],
  polledPreview: string,
): string {
  if (!isTextLikeKind(latest?.kind)) return polledPreview;
  return optionalText(latest?.text);
}

function childStreamHasOutput(
  rawPreview: string,
  toolName: string | undefined,
  latestBody: string,
  polledPreview: string,
  polledPhase: string,
): boolean {
  return (
    rawPreview !== '' ||
    toolName !== undefined ||
    latestBody !== '' ||
    polledPreview !== '' ||
    polledPhase !== ''
  );
}

function childStreamPreviewKind(
  fidelity: StreamFidelity,
  phase: ChildStreamPhase,
  kind: TranscriptEvent['kind'] | undefined,
): ChildStreamSnapshot['previewKind'] {
  if (fidelity === 'token' && phase === 'streaming' && isTextLikeKind(kind)) return 'markdown';
  return 'plain';
}

function childStreamStep(input: {
  phase: ChildStreamPhase;
  fidelity: StreamFidelity;
  polledPhase: string;
  latestHead: string;
  toolName: string | undefined;
}): string {
  if (input.polledPhase !== '') return input.polledPhase;
  if (input.latestHead !== '') return input.latestHead;
  if (input.fidelity === 'tool' && input.toolName) return input.toolName;
  if (input.phase === 'streaming') return 'Working';
  return CHILD_STREAM_PHASE_LABEL[input.phase];
}

export function childStreamPreviewBoxClass(expanded: boolean): string {
  return expanded ? CHILD_STREAM_PREVIEW_EXPANDED_BOX_CLASS : CHILD_STREAM_PREVIEW_BOX_CLASS;
}

export function childStreamSnapshot(
  child: ChildSessionSummary,
  activity: ChildSessionActivity | undefined,
  interruptReason?: string,
): ChildStreamSnapshot {
  const latest = activity?.latest;
  const polled = child.activity;
  const latestMeta = childSessionLatest(latest);
  const latestBody = optionalText(latestMeta?.body);
  const polledPreview = optionalText(polled?.preview);
  const polledPhase = optionalText(polled?.phase);
  const rawPreview = childStreamRawPreview(latest, polledPreview);
  const fidelity = child.streamFidelity;
  const phase = childStreamPhase({
    queued: child.queued,
    status: childStreamStatus(child, activity),
    latestKind: latest?.kind,
    isError: latest?.isError,
    hasOutput: childStreamHasOutput(
      rawPreview,
      latest?.toolName,
      latestBody,
      polledPreview,
      polledPhase,
    ),
    interruptReason,
  });
  const previewKind = childStreamPreviewKind(fidelity, phase, latest?.kind);
  return {
    key: childSessionKey(child),
    phase,
    fidelity,
    step: childStreamStep({
      phase,
      fidelity,
      polledPhase,
      latestHead: optionalText(latestMeta?.head),
      toolName: latest?.toolName,
    }),
    preview: boundChildStreamPreview(
      childStreamPreviewSource({
        fidelity,
        markdown: previewKind === 'markdown',
        rawPreview,
        latestBody,
        polledPreview,
        phase,
        prompt: optionalText(child.prompt),
      }),
    ),
    previewKind,
    live: phase === 'streaming' || phase === 'starting',
  };
}

function childStreamPreviewSource(input: {
  fidelity: StreamFidelity;
  markdown: boolean;
  rawPreview: string;
  latestBody: string;
  polledPreview: string;
  phase: ChildStreamPhase;
  prompt: string;
}): string {
  if (input.fidelity === 'token' && input.markdown) return input.rawPreview;
  if (input.fidelity === 'state') {
    if (input.polledPreview !== '') return input.polledPreview;
    if (input.latestBody !== '') return input.latestBody;
    if (input.phase === 'starting') return input.prompt;
    return '';
  }
  if (input.latestBody !== '') return input.latestBody;
  if (input.polledPreview !== '') return input.polledPreview;
  if (input.phase === 'starting') return input.prompt;
  return '';
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

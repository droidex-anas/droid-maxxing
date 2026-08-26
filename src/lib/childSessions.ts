import type { ChildStatus, ProgressEntry, TranscriptEvent } from '../types/bridge';
import type { ChildAccess, ChildSessionInfo } from '../hooks/useStore';
import { toolMeta, CAT_LABEL } from './tools';
import { childSessionInfo } from './childSessionEvents';
import {
  childSpawnTranscriptEvents,
  latestTranscriptActivityForSource,
} from './transcriptIngestion';

// A single Task spawn streams many tool_call/tool_call_delta events sharing one
// toolUseId; the subagent_type (label) and description can arrive in separate
// deltas, so merge their args rather than picking one event and dropping the
// field the other carried.
export { mergeChildSessionSpawn } from './childSessionEvents';

export interface ChildSessionLatest {
  kind: TranscriptEvent['kind'];
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  isError?: boolean;
}

export interface ChildSessionTarget {
  toolUseId?: string;
  label?: string;
}

export interface ChildSessionActivity {
  // The store's child status passes through verbatim; autonomous subagents
  // never open a runtime, so nothing here demotes running to paused.
  status?: ChildStatus;
  startedAt?: number;
  latest?: ChildSessionLatest;
}

export type VisibleSessionTarget =
  | { kind: 'primary' }
  | {
      kind: 'child';
      parentAppSessionId: string;
      childSessionId: string;
      child: ChildSessionInfo;
      access: ChildAccess | undefined;
      canSend: boolean;
      canInterrupt: boolean;
      settingsReadiness: 'opening' | 'ready' | 'failed';
    };

export interface ChildRuntimeSubmitTarget {
  parentAppSessionId: string;
  childSessionId: string;
  runtimeGeneration: number;
}

export function childRuntimeSubmitTarget(
  target: VisibleSessionTarget,
): ChildRuntimeSubmitTarget | undefined {
  if (target.kind !== 'child' || !target.canSend || target.access?.state !== 'ready')
    return undefined;
  return {
    parentAppSessionId: target.parentAppSessionId,
    childSessionId: target.childSessionId,
    runtimeGeneration: target.access.runtimeGeneration,
  };
}

export async function commitChildPromptAfterBaseline({
  capturedTarget,
  capturedComposerRevision,
  waitForBaseline,
  currentTarget,
  currentComposerRevision,
  canCommit = () => true,
  appendTranscript,
  resetComposer,
  sendCommand,
}: {
  capturedTarget: ChildRuntimeSubmitTarget;
  capturedComposerRevision: number;
  waitForBaseline: () => Promise<void>;
  currentTarget: () => VisibleSessionTarget;
  currentComposerRevision: () => number;
  canCommit?: () => boolean;
  appendTranscript: () => void;
  resetComposer: () => void;
  sendCommand: () => void;
}): Promise<boolean> {
  await waitForBaseline();
  const current = childRuntimeSubmitTarget(currentTarget());
  if (
    !canCommit() ||
    current?.parentAppSessionId !== capturedTarget.parentAppSessionId ||
    current.childSessionId !== capturedTarget.childSessionId ||
    current.runtimeGeneration !== capturedTarget.runtimeGeneration
  )
    return false;
  appendTranscript();
  if (currentComposerRevision() === capturedComposerRevision) resetComposer();
  sendCommand();
  return true;
}

export function selectedChildForParent(
  activeAppSessionId: string | undefined,
  selection: { parentAppSessionId: string; childSessionId: string } | null,
  childrenByParent: Partial<Record<string, Record<string, ChildSessionInfo>>>,
): ChildSessionInfo | undefined {
  if (!activeAppSessionId || selection?.parentAppSessionId !== activeAppSessionId) return undefined;
  return childrenByParent[activeAppSessionId]?.[selection.childSessionId];
}

export function visibleSessionTarget(
  activeAppSessionId: string | undefined,
  selection: { parentAppSessionId: string; childSessionId: string } | null,
  childrenByParent: Partial<Record<string, Record<string, ChildSessionInfo>>>,
  accessByParent: Partial<Record<string, Record<string, ChildAccess>>>,
): VisibleSessionTarget {
  const child = selectedChildForParent(activeAppSessionId, selection, childrenByParent);
  if (!activeAppSessionId || !selection || !child) return { kind: 'primary' };
  const access = accessByParent[activeAppSessionId]?.[selection.childSessionId];
  const ready = access?.state === 'ready' && child.status !== 'completed';
  return {
    kind: 'child',
    parentAppSessionId: activeAppSessionId,
    childSessionId: selection.childSessionId,
    child,
    access,
    canSend: ready,
    canInterrupt: ready && child.status === 'running',
    settingsReadiness: childSettingsReadiness(child, access, ready),
  };
}

function childSettingsReadiness(
  child: ChildSessionInfo,
  access: ChildAccess | undefined,
  isReady: boolean,
): 'failed' | 'opening' | 'ready' {
  if (child.status === 'completed') return 'failed';
  if (isReady) return 'ready';
  return access === undefined || access.state === 'opening' ? 'opening' : 'failed';
}

export function visibleSessionIsPending(
  target: VisibleSessionTarget,
  primaryIsLive: boolean,
  activeAgentId: string | null,
): boolean {
  return target.kind === 'child'
    ? target.canInterrupt
    : primaryIsLive && activeAgentId === 'primary';
}

export function visibleSessionCanCompact(target: VisibleSessionTarget): boolean {
  return target.kind === 'primary';
}

export function transcriptForVisibleSession(
  transcript: TranscriptEvent[],
  childSessionId: string | null,
): TranscriptEvent[] {
  return transcript.filter((event) => transcriptEventIsVisible(event, childSessionId));
}

export function transcriptEventIsVisible(
  event: TranscriptEvent,
  childSessionId: string | null,
): boolean {
  return childSessionId
    ? event.sourceSessionId === childSessionId
    : event.role === 'primary' || (event.author === 'user' && event.sourceSessionId === 'user');
}

export function shouldOpenSelectedChild(access: ChildAccess | undefined): boolean {
  return access === undefined;
}

export function shouldRequestReleasedChildHistory(access: ChildAccess | undefined): boolean {
  return access?.state !== 'opening';
}

export function childSessionIdForFeature(
  progress: ProgressEntry[],
  featureId: string,
): string | undefined {
  for (let i = progress.length - 1; i >= 0; i--) {
    const entry = progress[i];
    if (entry.featureId === featureId && entry.workerChildSessionId) {
      return entry.workerChildSessionId;
    }
  }
  return undefined;
}

export function childSelectionForFeature(
  progress: ProgressEntry[],
  childSessions: ChildSessionInfo[],
  featureId: string,
): string | null {
  const childSessionId = childSessionIdForFeature(progress, featureId);
  return childSessionId &&
    childSessions.some((childSession) => childSession.childSessionId === childSessionId)
    ? childSessionId
    : null;
}

export function orderedChildSessions(
  childSessions: readonly ChildSessionInfo[],
): ChildSessionInfo[] {
  return [...childSessions].sort(
    (a, b) =>
      (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.childSessionId.localeCompare(b.childSessionId),
  );
}

export function childSessionIsLive(
  childSession: Pick<ChildSessionInfo, 'status'>,
  runtime?: { available: boolean },
): boolean {
  return childSession.status === 'running' && runtime?.available === true;
}

export function childSessionLabel(childSession: ChildSessionInfo, index: number): string {
  if (childSession.label) return childSession.label;
  const role = childSession.role === 'validator' ? 'Validator' : 'Worker';
  return `${role} ${String(index + 1)}`;
}

export function childSessionMeta(
  childSession: ChildSessionInfo,
  displayedModel = childSession.modelId,
): string {
  return [
    childSession.role,
    childSession.status,
    displayedModel,
    childSession.reasoningEffort,
    // Autonomy is only known once a live runtime confirmed it; a parent value
    // must never stand in for an unopened or historical child.
    childSession.autonomy ? `${childSession.autonomy} autonomy` : 'provider managed',
    childSession.transcriptAvailable ? 'transcript' : 'no transcript',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function findChildSessionForTarget(
  childSessions: readonly ChildSessionInfo[],
  target: ChildSessionTarget,
): ChildSessionInfo | undefined {
  if (!target.toolUseId) return undefined;
  return childSessions.find(
    (childSession) =>
      childSession.spawnLink?.kind === 'tool-use' && childSession.spawnLink.id === target.toolUseId,
  );
}

// The spawn-event fields the dock needs to synthesize a placeholder session.
type ChildSessionSpawnRef = Pick<
  TranscriptEvent,
  'id' | 'toolUseId' | 'appSessionId' | 'ts' | 'endTs' | 'toolArgs'
>;

// Resolve each spawn in a wave to its registered child session. A spawn whose
// session hasn't reached the store yet gets a placeholder built from the spawn
// event itself, so the dock card renders the instant the spawn streams in
// instead of flashing per-spawn lines while the store catches up.
export function resolveWaveSessions(
  spawns: readonly ChildSessionSpawnRef[],
  childSessions: readonly ChildSessionInfo[],
): ChildSessionInfo[] {
  return spawns.map((spawn) => {
    const registered = findChildSessionForTarget(childSessions, { toolUseId: spawn.toolUseId });
    // The store stamps startedAt when the child session registers, which lags
    // the actual spawn; the wave's spawn event carries the true start time.
    if (registered?.startedAt != null && registered.startedAt > spawn.ts)
      return { ...registered, startedAt: spawn.ts };
    return registered ?? pendingChildSession(spawn);
  });
}

// Every subagent this session has spawned, whether or not the store has caught
// up. The feed card and the context panel must list the same agents at the same
// moment, and the store only registers a background Task once its provider
// session id is observed — which can lag the whole run — so both surfaces derive
// their rows from the spawn events and let registration fill the detail in.
export function spawnedChildSessions(
  transcript: readonly TranscriptEvent[],
  childSessions: readonly ChildSessionInfo[],
): ChildSessionInfo[] {
  const resolved = resolveWaveSessions(childSpawnTranscriptEvents(transcript), childSessions);
  const seen = new Set(resolved.map((child) => child.childSessionId));
  // A registered child whose spawn scrolled out of the loaded transcript window
  // (paged or compacted history) still belongs to the session.
  return [...resolved, ...childSessions.filter((child) => !seen.has(child.childSessionId))];
}

// A placeholder's childSessionId is replaced by the real one when the store
// registers the session, but its spawn link never changes; keying rows by the
// link keeps a row — and its creature avatar — identical across that swap.
export function childSessionKey(child: ChildSessionInfo): string {
  return child.spawnLink?.kind === 'tool-use' ? child.spawnLink.id : child.childSessionId;
}

export interface NamedChildSession {
  child: ChildSessionInfo;
  name: string;
  key: string;
}

// Panel display order: whatever is still working sits on top so a live agent is
// never pushed behind the fold, then newest spawn first. Recency (not status)
// ranks the rest so paging older history in — which reveals old spawns that
// often resolve to nothing more than "Awaiting status" placeholders — appends
// them behind the fold instead of reshuffling the visible rows.
export function workingFirstChildSessions(
  childSessions: readonly ChildSessionInfo[],
): NamedChildSession[] {
  // Fallback names are numbered from spawn order, so reordering must not
  // renumber anyone: "Worker 2" stays Worker 2 when Worker 1 finishes.
  return orderedChildSessions(childSessions)
    .map((child, index) => ({
      child,
      name: childSessionLabel(child, index),
      key: childSessionKey(child),
    }))
    .sort((a, b) => {
      const runningRank = (row: NamedChildSession) => (row.child.status === 'running' ? 0 : 1);
      return (
        runningRank(a) - runningRank(b) ||
        (b.child.startedAt ?? 0) - (a.child.startedAt ?? 0) ||
        a.child.childSessionId.localeCompare(b.child.childSessionId)
      );
    });
}

// Placeholder ids carry this prefix; unresolved spawns can't be opened.
export function isPendingChildPlaceholder(
  child: Pick<ChildSessionInfo, 'childSessionId'>,
): boolean {
  return child.childSessionId.startsWith('pending-');
}

function pendingChildSession(spawn: ChildSessionSpawnRef): ChildSessionInfo {
  const toolUseId = spawn.toolUseId ?? spawn.id;
  const info = childSessionInfo(spawn.toolArgs);
  return {
    parentAppSessionId: spawn.appSessionId,
    childSessionId: `pending-${toolUseId}`,
    role: 'worker',
    // Until the provider session registers, its lifecycle is unknown. Parent
    // activity and the Task tool call ending cannot prove that the background
    // child started or finished. Only an exact child lifecycle event may do so.
    status: 'pending',
    label: info.label ?? 'Subagent',
    prompt: info.description,
    modelId: '',
    spawnLink: { kind: 'tool-use', id: toolUseId },
    transcriptAvailable: false,
    startedAt: spawn.ts,
  };
}

export function childSessionActivityForTarget(
  childSessions: ChildSessionInfo[],
  allTx: TranscriptEvent[],
  target: ChildSessionTarget,
): ChildSessionActivity | undefined {
  const childSession = findChildSessionForTarget(childSessions, target);
  if (!childSession) return undefined;
  const latestEvent = latestTranscriptActivityForSource(allTx, childSession.childSessionId);
  let latest: ChildSessionLatest | undefined;
  if (latestEvent?.appSessionId === childSession.parentAppSessionId) {
    latest = {
      kind: latestEvent.kind,
      text: latestEvent.text,
      toolName: latestEvent.toolName,
      toolArgs: latestEvent.toolArgs,
      isError: latestEvent.isError,
    };
  }
  return {
    // Autonomous subagents never open a runtime, so runtime availability must
    // not demote a running child to "paused"; the store status is authoritative.
    status: childSession.status,
    startedAt: childSession.startedAt,
    latest,
  };
}

// Last non-empty line, capped, so a long thinking block stays a one-line cue.
export function previewLine(text?: string): string | undefined {
  if (!text) return undefined;
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || undefined;
}

// Map the child session's newest transcript event to a short head + body, mirroring
// how the main feed labels thinking/tool steps.
export function childSessionLatest(
  latest: ChildSessionLatest | undefined,
): { head: string; body?: string } | null {
  if (!latest) return null;
  // A failed tool result is surfaced by the activity scanners (which skip only
  // successful results), so render it as a failure instead of stale "Working".
  if (latest.isError || latest.kind === 'error') {
    const { detail } = toolMeta(latest.toolName, latest.toolArgs);
    return {
      head: latest.kind === 'tool_result' ? 'Failed' : 'Error',
      // First non-empty wins; empty strings are placeholders, not values.
      body: [previewLine(latest.text), detail, latest.toolName].find((text) => Boolean(text)),
    };
  }
  switch (latest.kind) {
    case 'thinking':
      return { head: 'Thinking', body: previewLine(latest.text) };
    case 'tool_call': {
      const { cat, detail } = toolMeta(latest.toolName, latest.toolArgs);
      return { head: CAT_LABEL[cat], body: detail || latest.toolName };
    }
    case 'text':
      return { head: 'Responding', body: previewLine(latest.text) };
    case 'status':
      return { head: 'Working', body: previewLine(latest.text) };
    default:
      return { head: 'Working', body: previewLine(latest.text) };
  }
}

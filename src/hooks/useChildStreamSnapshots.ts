import { useMemo, useRef } from 'react';
import type { ChildSessionSummary, TranscriptEvent } from '../types/bridge';
import { childSessionActivityForTarget, type ChildSessionActivity } from '../lib/childSessions';
import {
  childStreamSnapshotsAreLive,
  projectChildStreamSnapshots,
  type ChildStreamSnapshot,
} from '../lib/childSessionStream';
import { useFrameThrottledValue } from './useFrameThrottledValue';

export function useChildStreamSnapshots(
  children: readonly ChildSessionSummary[],
  transcript: readonly TranscriptEvent[],
  interruptReason: string | undefined,
): ReadonlyMap<string, ChildStreamSnapshot> {
  const previousRef = useRef<ReadonlyMap<string, ChildStreamSnapshot>>(new Map());
  const projected = useMemo(() => {
    const next = projectChildStreamSnapshots(
      children,
      (child) => activityForChild(children, transcript, child),
      interruptReason,
      previousRef.current,
    );
    previousRef.current = next;
    return next;
  }, [children, interruptReason, transcript]);
  return useFrameThrottledValue(projected, childStreamSnapshotsAreLive(projected));
}

function activityForChild(
  children: readonly ChildSessionSummary[],
  transcript: readonly TranscriptEvent[],
  child: ChildSessionSummary,
): ChildSessionActivity | undefined {
  if (child.spawnLink?.kind !== 'tool-use') {
    return { status: child.status, startedAt: child.startedAt };
  }
  return (
    childSessionActivityForTarget(children, transcript, {
      toolUseId: child.spawnLink.id,
      ...(child.label !== undefined ? { label: child.label } : {}),
    }) ?? { status: child.status, startedAt: child.startedAt }
  );
}

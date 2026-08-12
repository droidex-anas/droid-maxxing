import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import { shallowEqual, useStoreSelector, type AppState } from '../../hooks/useStore';
import { useSessionLive } from '../../hooks/useSessionLive';
import {
  activeTodoIndex,
  latestTodoSnapshot,
  type TodoItem,
  type TodoStatus,
} from '../../lib/tools';
import { scopeTranscriptToAgent } from '../../lib/transcript';
import { visibleSessionTarget } from '../../lib/childSessions';
import type { TranscriptEvent } from '../../types/bridge';

const EASE = [0.16, 1, 0.3, 1] as const;
const EMPTY_TRANSCRIPT: TranscriptEvent[] = [];

function sameTodoItems(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) => item.text === right[index]?.text && item.status === right[index]?.status,
    )
  );
}

function stepTone(item: TodoItem, isActive: boolean): string {
  if (isActive) return 'text-droid-text font-medium';
  if (item.status === 'completed') return 'text-droid-text-secondary';
  return 'text-droid-text-muted';
}

// Per-step status glyph: a filled ring once done, an empty ring for upcoming
// steps, and the empty ring with a spinning arc only while the model is working.
function StepRing({
  status,
  active,
  spinning,
}: {
  status: TodoStatus;
  active: boolean;
  spinning: boolean;
}) {
  if (status === 'completed') {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-droid-accent">
        <Check className="h-2 w-2 text-droid-bg" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={`h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-droid-text-muted/30 ${
        active && spinning ? 'border-t-droid-text' : ''
      } ${active && spinning ? 'animate-spin' : ''}`}
      style={active && spinning ? { animationDuration: '1.4s' } : undefined}
    />
  );
}

// The model's plan for the active session, tucked behind the composer. Mission
// control owns its own feature progress, so this stays out of those sessions.
export default function PlanSteps() {
  const { appSessionId, isMissionControl, selectedAgent } = useStoreSelector((state) => {
    const activeSession = state.activeAppSessionId
      ? state.sessions[state.activeAppSessionId]
      : null;
    const visibleTarget = visibleSessionTarget(
      activeSession?.appSessionId,
      state.selectedChild,
      state.childSessions,
      state.childAccess,
    );
    return {
      appSessionId: activeSession?.appSessionId ?? null,
      isMissionControl: activeSession?.sessionPurpose === 'mission-control',
      selectedAgent: visibleTarget.kind === 'child' ? visibleTarget.childSessionId : null,
    };
  }, shallowEqual);
  const isLive = useSessionLive(appSessionId);

  const selectSteps = useMemo(() => {
    let previousTranscript: readonly TranscriptEvent[] | null = null;
    let previousSteps: TodoItem[] = [];
    return (state: AppState): TodoItem[] => {
      const transcript =
        appSessionId && !isMissionControl
          ? (state.transcripts[appSessionId] ?? EMPTY_TRANSCRIPT)
          : EMPTY_TRANSCRIPT;
      if (transcript === previousTranscript) return previousSteps;
      previousTranscript = transcript;
      const nextSteps = latestTodoSnapshot(scopeTranscriptToAgent(transcript, selectedAgent)).todos;
      if (!sameTodoItems(previousSteps, nextSteps)) previousSteps = nextSteps;
      return previousSteps;
    };
  }, [appSessionId, isMissionControl, selectedAgent]);
  const steps = useStoreSelector(selectSteps);

  return (
    <PlanStepsPanel
      steps={steps}
      isRunning={isLive}
      resetKey={`${appSessionId ?? ''}:${selectedAgent ?? ''}`}
    />
  );
}

// One line for the step the plan is on, expandable into the whole list.
export function PlanStepsPanel({
  steps,
  isRunning,
  resetKey,
}: {
  steps: TodoItem[];
  isRunning: boolean;
  resetKey: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setExpanded(false);
  }, [resetKey]);
  useEffect(() => {
    if (!expanded) return;
    const collapseOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', collapseOutside);
    return () => {
      document.removeEventListener('pointerdown', collapseOutside);
    };
  }, [expanded]);

  const activeIndex = activeTodoIndex(steps);
  const current = activeIndex >= 0 ? steps[activeIndex] : undefined;
  const allDone = steps.length > 0 && steps.every((s) => s.status === 'completed');

  return (
    <AnimatePresence initial={false}>
      {current && (
        <motion.div
          ref={panelRef}
          key="plan-steps"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.22, ease: EASE }}
          className="relative z-0 mx-[6%] -mb-3 min-w-0 overflow-hidden rounded-t-2xl border border-droid-border bg-droid-surface pb-4"
        >
          <button
            type="button"
            onClick={() => {
              setExpanded((v) => !v);
            }}
            aria-expanded={expanded}
            aria-controls="plan-steps-list"
            className="flex w-full min-w-0 items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-droid-active/40"
          >
            <StepRing
              status={allDone ? 'completed' : current.status}
              active={!allDone}
              spinning={isRunning}
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
              {current.text}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            />
          </button>

          <motion.div
            id="plan-steps-list"
            initial={false}
            animate={{ height: expanded ? 'auto' : 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="expanded-steps min-h-0 max-h-[min(40vh,350px)] overflow-y-auto"
          >
            {steps.map((step, i) =>
              i === activeIndex ? null : (
                <div
                  key={`${String(i)}-${step.text}`}
                  className="flex min-w-0 items-center gap-2.5 px-4 py-1.5"
                >
                  <StepRing status={step.status} active={false} spinning={false} />
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${stepTone(step, false)}`}>
                    {step.text}
                  </span>
                </div>
              ),
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

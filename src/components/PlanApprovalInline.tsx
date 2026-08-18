import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { respondPermission, sendToSession, sendToSessionNow } from '../lib/commands';
import type { Autonomy, PermissionOutcome } from '../types/bridge';
import { isAppUpdateInstalling, useAppUpdate } from '../lib/appUpdate';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';

const AUTONOMY: { value: Autonomy; label: string; outcome: PermissionOutcome }[] = [
  { value: 'low', label: 'Low', outcome: 'proceed_auto_run_low' },
  { value: 'medium', label: 'Medium', outcome: 'proceed_auto_run_medium' },
  { value: 'high', label: 'High', outcome: 'proceed_auto_run_high' },
];

// Bottom approval bar shown when a spec (exit_spec_mode) or mission plan
// (propose_mission) is ready. Replaces the old full-screen popover: the plan
// itself lives in the inline chat card / wiki reader, this only drives the
// decision (implement vs keep iterating) plus an optional steered comment.
export default function PlanApprovalInline() {
  const dispatch = useStoreDispatch();
  const reduceMotion = useReducedMotion();
  const { downloading: appUpdateInstalling } = useAppUpdate();
  // Plan approvals are session-scoped: only surface the one belonging to the
  // chat the user is looking at.
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      pendingPermissions: current.pendingPermissions,
    }),
    shallowEqual,
  );
  const activeId = state.activeAppSessionId;
  const req = activeId ? state.pendingPermissions[activeId] : undefined;
  const [autonomy, setAutonomy] = useState<Autonomy>('high');
  const [comment, setComment] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autonomyRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Radio-group keyboard contract: only the checked option is a tab stop and
  // the arrow keys move focus and selection together.
  const onAutonomyKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!forward && !backward) return;
    e.preventDefault();
    const nextIndex = (index + (forward ? 1 : -1) + AUTONOMY.length) % AUTONOMY.length;
    setAutonomy(AUTONOMY[nextIndex].value);
    autonomyRefs.current[nextIndex]?.focus();
  };

  const requestId = req?.requestId;
  useEffect(() => {
    setComment('');
  }, [requestId]);

  if (!req || (req.kind !== 'spec' && req.kind !== 'mission_plan')) return null;

  const isSpec = req.kind === 'spec';
  const text = comment.trim();

  const finish = () => {
    dispatch({ type: 'CLEAR_PERMISSION', appSessionId: req.appSessionId });
  };

  // Implement: approve at the chosen autonomy (spec) or proceed once (mission),
  // then steer the comment into the turn the model is about to start.
  const implement = () => {
    if (isAppUpdateInstalling()) return;
    const autonomyOption = AUTONOMY.find((option) => option.value === autonomy);
    if (isSpec && !autonomyOption) return;
    const outcome: PermissionOutcome = isSpec
      ? (autonomyOption?.outcome ?? 'proceed_auto_run_high')
      : 'proceed_once';
    respondPermission(req.appSessionId, req.requestId, outcome);
    if (isSpec) {
      dispatch({
        type: 'SESSION_SET_INTERACTION_MODE',
        appSessionId: req.appSessionId,
        interactionMode: 'auto',
      });
    }
    if (text) sendToSessionNow(req.appSessionId, text);
    finish();
  };

  // Keep iterating: reject the plan and (optionally) hand the comment back as a
  // normal message so planning continues with the feedback.
  const iterate = () => {
    if (isAppUpdateInstalling()) return;
    respondPermission(req.appSessionId, req.requestId, 'cancel');
    if (text) sendToSession(req.appSessionId, text);
    finish();
  };

  const openWiki = () => {
    dispatch({ type: 'SPEC_OPEN_WIKI', appSessionId: req.appSessionId });
  };

  return (
    <AnimatePresence>
      <motion.div
        key={req.requestId}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: reduceMotion ? 0 : 0.22, ease: EASE }}
        className="mb-2.5 overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated shadow-[0_10px_32px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-3">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: ACCENT }}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-droid-text">
            {isSpec ? 'Specification ready' : 'Mission plan proposed'}
          </span>
          <button
            type="button"
            onClick={openWiki}
            className="flex shrink-0 items-center gap-0.5 rounded-full px-2 py-1 text-[11.5px] text-droid-text-secondary transition-colors hover:bg-droid-surface hover:text-droid-text"
          >
            {isSpec ? 'Read spec' : 'Read plan'}
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        <div className="px-4 pb-3">
          <textarea
            ref={inputRef}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
            }}
            onKeyDown={(e) => {
              // During IME composition Enter confirms the composed text;
              // only trigger implement once composition has ended.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                implement();
              }
            }}
            rows={1}
            placeholder={
              isSpec
                ? 'Add a comment to guide implementation (optional)…'
                : 'Add a comment (optional)…'
            }
            className="w-full resize-none rounded-xl border border-droid-border/70 bg-droid-bg/50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-droid-text placeholder:text-droid-text-muted/60 outline-none focus:border-droid-border-hover"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5">
          {isSpec && (
            <div
              role="radiogroup"
              aria-label="Implementation autonomy"
              className="flex items-center gap-0.5 rounded-full border border-droid-border p-0.5"
            >
              {AUTONOMY.map((a, i) => {
                const active = autonomy === a.value;
                return (
                  <button
                    key={a.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    ref={(el) => {
                      autonomyRefs.current[i] = el;
                    }}
                    onClick={() => {
                      setAutonomy(a.value);
                    }}
                    onKeyDown={(e) => {
                      onAutonomyKeyDown(e, i);
                    }}
                    title={`Implement with ${a.label.toLowerCase()} autonomy`}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active ? 'text-droid-bg' : 'text-droid-text-secondary hover:text-droid-text'
                    }`}
                    style={active ? { background: ACCENT } : undefined}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={iterate}
            disabled={appUpdateInstalling}
            title={appUpdateInstalling ? 'Installing DROIDEX update' : undefined}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors enabled:hover:bg-droid-surface enabled:hover:text-droid-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Keep iterating
          </button>
          <button
            type="button"
            onClick={implement}
            disabled={appUpdateInstalling}
            title={appUpdateInstalling ? 'Installing DROIDEX update' : undefined}
            className="rounded-full px-4 py-1.5 text-[12px] font-semibold text-droid-bg transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: ACCENT }}
          >
            {text ? 'Implement with comment' : 'Implement'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

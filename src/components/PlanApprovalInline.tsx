import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FileText, ChevronRight } from 'lucide-react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { respondPermission, sendToSession, sendToSessionNow } from '../lib/commands';
import type { Autonomy, PermissionOutcome } from '../types/bridge';
import { ComposerRequestShell } from './ComposerRequestShell';

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
    respondPermission(req.appSessionId, req.requestId, 'cancel');
    if (text) sendToSession(req.appSessionId, text);
    finish();
  };

  const openWiki = () => {
    dispatch({ type: 'SPEC_OPEN_WIKI', appSessionId: req.appSessionId });
  };

  return (
    <AnimatePresence>
      <ComposerRequestShell
        key={req.requestId}
        label="Approval"
        title={
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-droid-text-secondary" />
            {isSpec ? 'The specification is ready to implement.' : 'The mission plan is ready.'}
          </span>
        }
        description={
          isSpec
            ? 'Review the specification, choose an autonomy level, then implement or keep refining it.'
            : 'Review the plan, then start the mission or keep refining it.'
        }
        detail={
          <>
            <button
              type="button"
              onClick={openWiki}
              className="mb-2.5 flex items-center gap-1 rounded-lg border border-droid-border px-2.5 py-1.5 text-[11px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
            >
              {isSpec ? 'Read specification' : 'Read plan'}
              <ChevronRight className="h-3 w-3" />
            </button>
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
              className="w-full resize-none rounded-xl border border-droid-border bg-droid-bg/55 px-3 py-2.5 text-[12.5px] leading-snug text-droid-text placeholder:text-droid-text-muted/60 outline-none focus:border-droid-border-hover"
            />
          </>
        }
        actions={
          <>
            {isSpec && (
              <div className="mr-auto flex items-center gap-1 rounded-lg border border-droid-border p-0.5">
                {AUTONOMY.map((a) => {
                  const active = autonomy === a.value;
                  return (
                    <button
                      key={a.value}
                      onClick={() => {
                        setAutonomy(a.value);
                      }}
                      title={`Implement with ${a.label.toLowerCase()} autonomy`}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
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
            <button
              type="button"
              onClick={iterate}
              className="rounded-lg border border-droid-border px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
            >
              Keep iterating
            </button>
            <button
              type="button"
              onClick={implement}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
              style={{ background: ACCENT }}
            >
              {text ? 'Implement with comment' : 'Implement'}
            </button>
          </>
        }
      />
    </AnimatePresence>
  );
}

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { respondQuestion } from '../lib/commands';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';

// Inline question card shown above the composer when Droid asks the user
// something. Questions are session-scoped: only surface the one belonging to
// the chat the user is looking at; other sessions signal via the sidebar.
export default function AskUserInline() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      pendingQuestions: current.pendingQuestions,
    }),
    shallowEqual,
  );
  const activeId = state.activeAppSessionId;
  const question = activeId ? state.pendingQuestions[activeId] : undefined;

  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const requestId = question?.requestId;
  useEffect(() => {
    setCurrent(0);
    setAnswers({});
    setCustomOpen({});
  }, [requestId]);

  useEffect(() => {
    if (customOpen[question?.questions[current]?.index ?? -1]) {
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => {
        clearTimeout(t);
      };
    }
  }, [customOpen, current, question]);

  if (!question) return null;

  const q = question.questions[current];
  const total = question.questions.length;
  const isLast = current === total - 1;
  const answer = (answers[q.index] ?? '').trim();
  const typing = customOpen[q.index] ?? false;
  const canAdvance = answer.length > 0;

  const pickOption = (opt: string) => {
    setAnswers((p) => ({ ...p, [q.index]: opt }));
    setCustomOpen((p) => ({ ...p, [q.index]: false }));
  };

  const openCustom = () => {
    setCustomOpen((p) => ({ ...p, [q.index]: true }));
  };

  const next = () => {
    if (!canAdvance) return;
    if (isLast) {
      const payload = question.questions.map((qq) => ({
        index: qq.index,
        question: qq.question,
        answer: (answers[qq.index] ?? '').trim(),
      }));
      respondQuestion(question.appSessionId, question.requestId, false, payload);
      dispatch({ type: 'CLEAR_QUESTION', appSessionId: question.appSessionId });
    } else {
      setCurrent((c) => c + 1);
    }
  };

  const cancel = () => {
    respondQuestion(question.appSessionId, question.requestId, true, []);
    dispatch({ type: 'CLEAR_QUESTION', appSessionId: question.appSessionId });
  };

  return (
    <AnimatePresence>
      <motion.div
        key={question.requestId}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.985 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="mb-2.5 overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated shadow-[0_10px_32px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-start gap-2 px-4 pt-3.5">
          <span
            className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: ACCENT }}
            aria-hidden
          />
          <div className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-droid-text break-words">
            {q.question}
          </div>
          {total > 1 && (
            <span className="shrink-0 pt-px text-[11px] text-droid-text-muted">
              {current + 1} of {total}
            </span>
          )}
        </div>

        <div className="mt-2.5 space-y-1 px-3">
          {q.options.map((opt, i) => {
            const selected = !typing && answer === opt.trim();
            return (
              <button
                key={`${opt}-${String(i)}`}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  pickOption(opt);
                }}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? 'border-droid-border-hover bg-droid-bg/55'
                    : 'border-transparent hover:border-droid-border hover:bg-droid-bg/30'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    selected ? 'border-droid-text-secondary' : 'border-droid-text-muted/50'
                  }`}
                  aria-hidden="true"
                >
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-droid-text" />}
                </span>
                <span
                  className={`text-[13px] leading-snug break-words ${
                    selected ? 'text-droid-text' : 'text-droid-text-secondary'
                  }`}
                >
                  {opt}
                </span>
              </button>
            );
          })}

          <div
            className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
              typing
                ? 'border-droid-border-hover bg-droid-bg/55'
                : 'border-transparent hover:border-droid-border hover:bg-droid-bg/30'
            }`}
          >
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                typing ? 'border-droid-text-secondary' : 'border-droid-text-muted/50'
              }`}
              aria-hidden="true"
            >
              {typing && <span className="h-1.5 w-1.5 rounded-full bg-droid-text" />}
            </span>
            {typing ? (
              <input
                ref={inputRef}
                type="text"
                value={answers[q.index] ?? ''}
                onChange={(e) => {
                  setAnswers((p) => ({ ...p, [q.index]: e.target.value }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    next();
                  }
                }}
                placeholder="Type your own answer"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-droid-text placeholder:text-droid-text-muted/60 outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={openCustom}
                className="min-w-0 flex-1 text-left text-[13px] text-droid-text-secondary"
              >
                Type your own answer
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 pt-2.5 pb-3.5">
          {current > 0 && (
            <button
              type="button"
              onClick={() => {
                setCurrent((c) => c - 1);
              }}
              className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-surface hover:text-droid-text"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={cancel}
            className="rounded-full border border-droid-border bg-droid-bg/40 px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={next}
            disabled={!canAdvance}
            className="rounded-full px-4 py-1.5 text-[12px] font-semibold text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            style={{ background: ACCENT }}
          >
            {isLast ? 'Submit' : 'Next'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

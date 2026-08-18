import { useEffect, useReducer, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { respondQuestion } from '../lib/commands';
import type { SessionQuestion } from '../types/bridge';
import { inlineCardMotion } from './inlineCardMotion';
import {
  answerFor,
  canAdvance,
  createStepper,
  isLastStep,
  isTyping,
  stepperReducer,
  submissionAnswers,
} from './askUserStepper';

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
  const isEmpty = question?.questions.length === 0;

  // A request without questions cannot be answered; cancel it so the pending
  // interaction settles instead of wedging the composer.
  useEffect(() => {
    if (question?.questions.length === 0) {
      respondQuestion(question.appSessionId, question.requestId, true, []);
      dispatch({ type: 'CLEAR_QUESTION', appSessionId: question.appSessionId });
    }
  }, [question, dispatch]);

  // The card is keyed by request so a new request mounts a fresh card instead
  // of carrying the previous step and answers into its first render.
  return (
    <AnimatePresence>
      {question && !isEmpty && (
        <QuestionCard
          key={question.requestId}
          question={question}
          onAnswer={(answers) => {
            respondQuestion(question.appSessionId, question.requestId, false, answers);
            dispatch({ type: 'CLEAR_QUESTION', appSessionId: question.appSessionId });
          }}
          onCancel={() => {
            respondQuestion(question.appSessionId, question.requestId, true, []);
            dispatch({ type: 'CLEAR_QUESTION', appSessionId: question.appSessionId });
          }}
        />
      )}
    </AnimatePresence>
  );
}

// One ask-user request as a stepper: a radio row per option plus a
// type-your-own row, Back/Next across questions, Submit on the last one.
export function QuestionCard({
  question,
  onAnswer,
  onCancel,
}: {
  question: SessionQuestion;
  onAnswer: (answers: { index: number; question: string; answer: string }[]) => void;
  onCancel: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const total = question.questions.length;
  const [stepper, dispatchStep] = useReducer(stepperReducer, total, createStepper);
  const inputRef = useRef<HTMLInputElement>(null);

  const step = stepper.current;
  const q = question.questions[step];
  const isLast = isLastStep(stepper);
  const answer = answerFor(stepper, q.index);
  const typing = isTyping(stepper, q.index);
  const advanceEnabled = canAdvance(stepper, q.index);

  useEffect(() => {
    if (typing) {
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => {
        clearTimeout(t);
      };
    }
  }, [typing, step]);

  const pickOption = (opt: string) => {
    dispatchStep({ type: 'pickOption', questionIndex: q.index, option: opt });
  };

  const openCustom = () => {
    dispatchStep({ type: 'openCustomAnswer', questionIndex: q.index });
  };

  const next = () => {
    if (!advanceEnabled) return;
    if (isLast) onAnswer(submissionAnswers(question.questions, stepper));
    else dispatchStep({ type: 'forward' });
  };

  return (
    <motion.div
      {...inlineCardMotion(reduceMotion)}
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
            {step + 1} of {total}
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
              value={stepper.answers[q.index] ?? ''}
              onChange={(e) => {
                dispatchStep({ type: 'typeAnswer', questionIndex: q.index, value: e.target.value });
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
        {step > 0 && (
          <button
            type="button"
            onClick={() => {
              dispatchStep({ type: 'back' });
            }}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-surface hover:text-droid-text"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-droid-border bg-droid-bg/40 px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={next}
          disabled={!advanceEnabled}
          className="rounded-full px-4 py-1.5 text-[12px] font-semibold text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          style={{ background: ACCENT }}
        >
          {isLast ? 'Submit' : 'Next'}
        </button>
      </div>
    </motion.div>
  );
}

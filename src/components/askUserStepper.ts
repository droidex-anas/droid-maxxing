// Stepper state for the inline ask-user card: which question is showing, the
// answer held for each question, and whether that answer is being typed rather
// than picked. Kept pure so the flow (pick, type, back, forward, submit payload)
// is testable without a DOM; AskUserInline owns focus and the actual commands.
//
// Answers are keyed by the question's own index, not by step position, so
// stepping back and forth never reassigns an answer to a different question.

import type { SessionQuestion } from '../types/bridge';

export interface StepperState {
  readonly total: number;
  readonly current: number;
  readonly answers: Readonly<Record<number, string>>;
  /** Question indexes whose answer is being typed instead of chosen. */
  readonly typing: Readonly<Record<number, boolean>>;
}

export type StepperAction =
  | { type: 'pickOption'; questionIndex: number; option: string }
  | { type: 'openCustomAnswer'; questionIndex: number }
  | { type: 'typeAnswer'; questionIndex: number; value: string }
  | { type: 'back' }
  | { type: 'forward' };

export function createStepper(total: number): StepperState {
  return { total, current: 0, answers: {}, typing: {} };
}

export function stepperReducer(state: StepperState, action: StepperAction): StepperState {
  switch (action.type) {
    case 'pickOption':
      return {
        ...state,
        answers: { ...state.answers, [action.questionIndex]: action.option },
        typing: { ...state.typing, [action.questionIndex]: false },
      };
    // The field opens on whatever answer is already held, so a picked option can
    // be edited into a custom one instead of retyped from scratch.
    case 'openCustomAnswer':
      return { ...state, typing: { ...state.typing, [action.questionIndex]: true } };
    case 'typeAnswer':
      return {
        ...state,
        answers: { ...state.answers, [action.questionIndex]: action.value },
        typing: { ...state.typing, [action.questionIndex]: true },
      };
    case 'back':
      return state.current === 0 ? state : { ...state, current: state.current - 1 };
    case 'forward':
      return state.current >= state.total - 1 ? state : { ...state, current: state.current + 1 };
  }
}

/** Trimmed answer held for a question, empty when it has none yet. */
export function answerFor(state: StepperState, questionIndex: number): string {
  return (state.answers[questionIndex] ?? '').trim();
}

export function isTyping(state: StepperState, questionIndex: number): boolean {
  return state.typing[questionIndex] ?? false;
}

/** An empty or whitespace-only answer cannot be submitted or stepped past. */
export function canAdvance(state: StepperState, questionIndex: number): boolean {
  return answerFor(state, questionIndex).length > 0;
}

export function isLastStep(state: StepperState): boolean {
  return state.current === state.total - 1;
}

/** Payload for respondQuestion: every question with its trimmed answer. */
export function submissionAnswers(
  questions: SessionQuestion['questions'],
  state: StepperState,
): { index: number; question: string; answer: string }[] {
  return questions.map((q) => ({
    index: q.index,
    question: q.question,
    answer: answerFor(state, q.index),
  }));
}

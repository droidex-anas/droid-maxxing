// Stepper state for the inline ask-user card: which question is showing, the
// answers held for each question, and whether that answer is being typed rather
// than picked. Kept pure so the flow (pick, type, back, forward, submit payload)
// is testable without a DOM; AskUserInline owns focus and the actual commands.
//
// Answers are keyed by the question's own id, so stepping back and forth never
// reassigns an answer to a different question.

import type { SessionQuestion } from '../types/bridge';

export interface StepperState {
  readonly total: number;
  readonly current: number;
  readonly answers: Readonly<Record<string, readonly string[]>>;
  /** Question ids whose answer is being typed instead of chosen. */
  readonly typing: Readonly<Record<string, boolean>>;
}

export type StepperAction =
  | { type: 'pickOption'; questionId: string; option: string }
  | { type: 'toggleOption'; questionId: string; option: string }
  | { type: 'openCustomAnswer'; questionId: string }
  | { type: 'typeAnswer'; questionId: string; value: string }
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
        answers: { ...state.answers, [action.questionId]: [action.option] },
        typing: { ...state.typing, [action.questionId]: false },
      };
    case 'toggleOption': {
      const current = state.answers[action.questionId] ?? [];
      const next = current.includes(action.option)
        ? current.filter((option) => option !== action.option)
        : [...current, action.option];
      return {
        ...state,
        answers: { ...state.answers, [action.questionId]: next },
        typing: { ...state.typing, [action.questionId]: false },
      };
    }
    case 'openCustomAnswer':
      return { ...state, typing: { ...state.typing, [action.questionId]: true } };
    case 'typeAnswer':
      return {
        ...state,
        answers: { ...state.answers, [action.questionId]: [action.value] },
        typing: { ...state.typing, [action.questionId]: true },
      };
    case 'back':
      return state.current === 0 ? state : { ...state, current: state.current - 1 };
    case 'forward':
      return state.current >= state.total - 1 ? state : { ...state, current: state.current + 1 };
  }
}

/** Trimmed answers held for a question. */
export function answersFor(state: StepperState, questionId: string): readonly string[] {
  return (state.answers[questionId] ?? []).map((value) => value.trim()).filter((value) => value);
}

export function answerFor(state: StepperState, questionId: string): string {
  return answersFor(state, questionId).join(', ');
}

export function isTyping(state: StepperState, questionId: string): boolean {
  return state.typing[questionId] ?? false;
}

/** An empty or whitespace-only answer cannot be submitted or stepped past. */
export function canAdvance(state: StepperState, questionId: string): boolean {
  return answersFor(state, questionId).length > 0;
}

export function isLastStep(state: StepperState): boolean {
  return state.current === state.total - 1;
}

/** Payload for respondQuestion: exact question keys with string arrays. */
export function submissionAnswers(
  questions: SessionQuestion['questions'],
  state: StepperState,
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    answers[question.id] = [...answersFor(state, question.id)];
  }
  return answers;
}

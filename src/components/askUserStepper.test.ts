import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerFor,
  canAdvance,
  createStepper,
  isLastStep,
  isTyping,
  stepperReducer,
  submissionAnswers,
  type StepperAction,
  type StepperState,
} from './askUserStepper';

const QUESTIONS = [
  { index: 0, question: 'Which database?', options: ['SQLite', 'Postgres'] },
  { index: 1, question: 'Which host?', options: ['Local', 'Cloud'] },
];

function run(total: number, actions: StepperAction[]): StepperState {
  return actions.reduce(stepperReducer, createStepper(total));
}

test('a fresh stepper starts on the first question with no answers', () => {
  const state = createStepper(2);

  assert.equal(state.current, 0);
  assert.equal(answerFor(state, 0), '');
  assert.equal(canAdvance(state, 0), false);
  assert.equal(isLastStep(state), false);
});

test('picking an option records it and leaves typing mode', () => {
  const state = run(1, [
    { type: 'openCustomAnswer', questionIndex: 0 },
    { type: 'pickOption', questionIndex: 0, option: 'Postgres' },
  ]);

  assert.equal(answerFor(state, 0), 'Postgres');
  assert.equal(isTyping(state, 0), false);
  assert.equal(canAdvance(state, 0), true);
});

test('the custom field opens on the picked answer so it can be edited', () => {
  const picked = run(1, [
    { type: 'pickOption', questionIndex: 0, option: 'SQLite' },
    { type: 'openCustomAnswer', questionIndex: 0 },
  ]);

  assert.equal(picked.answers[0], 'SQLite');
  assert.equal(isTyping(picked, 0), true);

  const edited = stepperReducer(picked, {
    type: 'typeAnswer',
    questionIndex: 0,
    value: 'SQLite via Turso',
  });

  assert.equal(answerFor(edited, 0), 'SQLite via Turso');
  assert.equal(isTyping(edited, 0), true);
});

test('a whitespace-only answer cannot advance', () => {
  const state = run(1, [{ type: 'typeAnswer', questionIndex: 0, value: '   ' }]);

  assert.equal(answerFor(state, 0), '');
  assert.equal(canAdvance(state, 0), false);
});

test('forward and back clamp to the question range', () => {
  const atEnd = run(2, [{ type: 'forward' }, { type: 'forward' }]);
  assert.equal(atEnd.current, 1);
  assert.equal(isLastStep(atEnd), true);

  const atStart = run(2, [{ type: 'back' }]);
  assert.equal(atStart.current, 0);
});

test('answers stay attached to their own question across back and forward', () => {
  const state = run(2, [
    { type: 'pickOption', questionIndex: 0, option: 'SQLite' },
    { type: 'forward' },
    { type: 'typeAnswer', questionIndex: 1, value: 'Fly.io' },
    { type: 'back' },
    { type: 'pickOption', questionIndex: 0, option: 'Postgres' },
    { type: 'forward' },
  ]);

  assert.equal(answerFor(state, 0), 'Postgres');
  assert.equal(answerFor(state, 1), 'Fly.io');
  assert.equal(isTyping(state, 0), false);
  assert.equal(isTyping(state, 1), true);
});

test('the submission payload carries every question with its trimmed answer', () => {
  const state = run(2, [
    { type: 'pickOption', questionIndex: 0, option: 'Postgres' },
    { type: 'forward' },
    { type: 'typeAnswer', questionIndex: 1, value: '  Fly.io  ' },
  ]);

  assert.deepEqual(submissionAnswers(QUESTIONS, state), [
    { index: 0, question: 'Which database?', answer: 'Postgres' },
    { index: 1, question: 'Which host?', answer: 'Fly.io' },
  ]);
});

test('unanswered questions submit as empty answers rather than being dropped', () => {
  const state = run(2, [{ type: 'pickOption', questionIndex: 0, option: 'SQLite' }]);

  assert.deepEqual(submissionAnswers(QUESTIONS, state), [
    { index: 0, question: 'Which database?', answer: 'SQLite' },
    { index: 1, question: 'Which host?', answer: '' },
  ]);
});

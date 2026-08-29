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
  { id: 'db', prompt: 'Which database?', options: ['SQLite', 'Postgres'], multiSelect: false },
  { id: 'host', prompt: 'Which host?', options: ['Local', 'Cloud'], multiSelect: false },
];

function run(total: number, actions: StepperAction[]): StepperState {
  return actions.reduce(stepperReducer, createStepper(total));
}

test('a fresh stepper starts on the first question with no answers', () => {
  const state = createStepper(2);

  assert.equal(state.current, 0);
  assert.equal(answerFor(state, 'db'), '');
  assert.equal(canAdvance(state, 'db'), false);
  assert.equal(isLastStep(state), false);
});

test('picking an option records it and leaves typing mode', () => {
  const state = run(1, [
    { type: 'openCustomAnswer', questionId: 'db' },
    { type: 'pickOption', questionId: 'db', option: 'Postgres' },
  ]);

  assert.equal(answerFor(state, 'db'), 'Postgres');
  assert.equal(isTyping(state, 'db'), false);
  assert.equal(canAdvance(state, 'db'), true);
});

test('the custom field opens on the picked answer so it can be edited', () => {
  const picked = run(1, [
    { type: 'pickOption', questionId: 'db', option: 'SQLite' },
    { type: 'openCustomAnswer', questionId: 'db' },
  ]);

  assert.deepEqual(picked.answers.db, ['SQLite']);
  assert.equal(isTyping(picked, 'db'), true);

  const edited = stepperReducer(picked, {
    type: 'typeAnswer',
    questionId: 'db',
    value: 'SQLite via Turso',
  });

  assert.equal(answerFor(edited, 'db'), 'SQLite via Turso');
  assert.equal(isTyping(edited, 'db'), true);
});

test('a whitespace-only answer cannot advance', () => {
  const state = run(1, [{ type: 'typeAnswer', questionId: 'db', value: '   ' }]);

  assert.equal(answerFor(state, 'db'), '');
  assert.equal(canAdvance(state, 'db'), false);
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
    { type: 'pickOption', questionId: 'db', option: 'SQLite' },
    { type: 'forward' },
    { type: 'typeAnswer', questionId: 'host', value: 'Fly.io' },
    { type: 'back' },
    { type: 'pickOption', questionId: 'db', option: 'Postgres' },
    { type: 'forward' },
  ]);

  assert.equal(answerFor(state, 'db'), 'Postgres');
  assert.equal(answerFor(state, 'host'), 'Fly.io');
  assert.equal(isTyping(state, 'db'), false);
  assert.equal(isTyping(state, 'host'), true);
});

test('the submission payload carries every question with its trimmed answer', () => {
  const state = run(2, [
    { type: 'pickOption', questionId: 'db', option: 'Postgres' },
    { type: 'forward' },
    { type: 'typeAnswer', questionId: 'host', value: '  Fly.io  ' },
  ]);

  assert.deepEqual(submissionAnswers(QUESTIONS, state), {
    db: ['Postgres'],
    host: ['Fly.io'],
  });
});

test('unanswered questions submit as empty answers rather than being dropped', () => {
  const state = run(2, [{ type: 'pickOption', questionId: 'db', option: 'SQLite' }]);

  assert.deepEqual(submissionAnswers(QUESTIONS, state), {
    db: ['SQLite'],
    host: [],
  });
});

test('multi-select toggles options without replacing earlier picks', () => {
  const state = run(1, [
    { type: 'toggleOption', questionId: 'tags', option: 'alpha' },
    { type: 'toggleOption', questionId: 'tags', option: 'beta' },
    { type: 'toggleOption', questionId: 'tags', option: 'alpha' },
  ]);

  assert.deepEqual(state.answers.tags, ['beta']);
  assert.equal(canAdvance(state, 'tags'), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cursorCreatePlanAcpResult,
  cursorTodoFingerprint,
  parseCursorAskQuestion,
  parseCursorCreatePlan,
  parseCursorUpdateTodos,
  questionRequestFromAskQuestion,
  reconstructCursorAskQuestionAnswers,
} from './cursorExtensions.js';

const ASK_PAYLOAD = {
  toolCallId: 'ask-1',
  title: 'Choose',
  questions: [
    {
      id: 'exact-q-id',
      prompt: 'Pick one',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
    },
    {
      id: 'multi-q',
      prompt: 'Pick many',
      allowMultiple: true,
      options: [
        { id: 'x', label: 'X-ray' },
        { id: 'y', label: 'Yankee' },
      ],
    },
  ],
};

test('cursor/ask_question preserves exact question ids and multi-select shape', () => {
  const parsed = parseCursorAskQuestion(ASK_PAYLOAD);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.questions.map((question) => question.id),
    ['exact-q-id', 'multi-q'],
  );
  const request = questionRequestFromAskQuestion(parsed);
  assert.equal(request[0]?.multiSelect, false);
  assert.equal(request[1]?.multiSelect, true);
  const native = reconstructCursorAskQuestionAnswers(parsed.questions, {
    status: 'answered',
    answers: { 'exact-q-id': ['a'], 'multi-q': ['x', 'y'] },
  });
  assert.deepEqual(native, {
    answers: { 'exact-q-id': 'a', 'multi-q': ['x', 'y'] },
  });
  const fromLabels = reconstructCursorAskQuestionAnswers(parsed.questions, {
    status: 'answered',
    answers: { 'exact-q-id': ['Alpha'], 'multi-q': ['X-ray', 'Yankee'] },
  });
  assert.deepEqual(fromLabels, {
    answers: { 'exact-q-id': 'a', 'multi-q': ['x', 'y'] },
  });
  assert.deepEqual(reconstructCursorAskQuestionAnswers(parsed.questions, { status: 'cancelled' }), {
    answers: {},
  });
});

test('single-select and multi-select answers are shaped differently', () => {
  const parsed = parseCursorAskQuestion(ASK_PAYLOAD);
  assert.ok(parsed);
  const first = parsed.questions[0];
  const second = parsed.questions[1];
  assert.ok(first);
  assert.ok(second);
  const single = reconstructCursorAskQuestionAnswers([first], {
    status: 'answered',
    answers: { 'exact-q-id': ['b'] },
  });
  const multi = reconstructCursorAskQuestionAnswers([second], {
    status: 'answered',
    answers: { 'multi-q': ['y'] },
  });
  assert.equal(typeof single.answers['exact-q-id'], 'string');
  assert.equal(Array.isArray(multi.answers['multi-q']), true);
});

test('cursor/create_plan maps implement, iterate, and cancel', () => {
  const parsed = parseCursorCreatePlan({
    toolCallId: 'plan-1',
    plan: '# Do the thing',
    todos: [{ content: 'step one', status: 'pending' }],
  });
  assert.equal(parsed?.plan, '# Do the thing');
  assert.deepEqual(cursorCreatePlanAcpResult({ decision: 'implement' }), { accepted: true });
  assert.deepEqual(cursorCreatePlanAcpResult({ decision: 'iterate', feedback: 'more detail' }), {
    accepted: false,
    feedback: 'more detail',
  });
  assert.deepEqual(cursorCreatePlanAcpResult({ decision: 'cancel' }), { accepted: false });
});

test('cursor/update_todos fingerprints content so unchanged lists match', () => {
  const first = parseCursorUpdateTodos({
    toolCallId: 'todos-1',
    merge: false,
    todos: [{ id: '1', content: 'Write tests', status: 'pending' }],
  });
  const same = parseCursorUpdateTodos({
    toolCallId: 'todos-2',
    merge: true,
    todos: [{ id: '1', content: 'Write tests', status: 'pending' }],
  });
  const changed = parseCursorUpdateTodos({
    toolCallId: 'todos-3',
    merge: false,
    todos: [{ id: '1', content: 'Write tests', status: 'completed' }],
  });
  assert.ok(first && same && changed);
  assert.equal(cursorTodoFingerprint(first.todos), cursorTodoFingerprint(same.todos));
  assert.notEqual(cursorTodoFingerprint(first.todos), cursorTodoFingerprint(changed.todos));
});

test('malformed extension payloads fail validation without throwing', () => {
  assert.equal(parseCursorAskQuestion({ toolCallId: 'x' }), undefined);
  assert.equal(parseCursorCreatePlan({ toolCallId: 'x', todos: [] }), undefined);
  assert.equal(parseCursorUpdateTodos({ toolCallId: 'x', todos: [] }), undefined);
});

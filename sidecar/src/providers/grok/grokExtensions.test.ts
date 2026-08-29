import assert from 'node:assert/strict';
import test from 'node:test';

import {
  grokAnswersKeyedByQuestionText,
  grokQuestionsForSink,
  makeXaiAskUserQuestionResponse,
  makeXaiExitPlanModeCapturedResponse,
  unwrapAskUserQuestionParams,
  unwrapExitPlanModeParams,
  XAI_EMPTY_PLAN_MARKDOWN,
  extractXaiExitPlanMarkdown,
} from './grokExtensions.js';

const askParams = {
  sessionId: 's1',
  toolCallId: 't1',
  mode: 'default' as const,
  questions: [
    {
      id: 'scope',
      question: 'Which scope should Grok use?',
      options: [{ label: 'Workspace' }, { label: 'Session' }],
    },
    {
      question: 'Which changes should be included?',
      multiSelect: true,
      options: [{ label: 'Tests' }, { label: 'Docs' }],
    },
  ],
};

test('accepts both prefixed and unprefixed ask_user_question payloads', () => {
  assert.deepEqual(unwrapAskUserQuestionParams(askParams)?.sessionId, 's1');
  assert.deepEqual(
    unwrapAskUserQuestionParams({
      method: '_x.ai/ask_user_question',
      params: askParams,
    })?.toolCallId,
    't1',
  );
  assert.equal(unwrapAskUserQuestionParams({ nope: true }), undefined);
});

test('ask_user_question answers are keyed by question text including multi-select', () => {
  const questions = grokQuestionsForSink(askParams);
  assert.equal(questions[0]?.id, 'scope');
  assert.equal(questions[1]?.id, 'Which changes should be included?');
  assert.equal(questions[1]?.multiSelect, true);
  const keyed = grokAnswersKeyedByQuestionText(askParams, {
    scope: ['Workspace'],
    'Which changes should be included?': ['Tests', 'Docs'],
  });
  assert.deepEqual(keyed, {
    'Which scope should Grok use?': ['Workspace'],
    'Which changes should be included?': ['Tests', 'Docs'],
  });
  assert.deepEqual(
    makeXaiAskUserQuestionResponse(askParams, { scope: ['Workspace'] }).answers[
      'Which scope should Grok use?'
    ],
    ['Workspace'],
  );
});

test('accepts both prefixed and unprefixed exit_plan_mode payloads and captures promptly', () => {
  const params = { sessionId: 's1', toolCallId: 't1', planContent: '# Plan\n' };
  assert.equal(unwrapExitPlanModeParams(params)?.planContent, '# Plan\n');
  assert.equal(
    unwrapExitPlanModeParams({ method: 'x.ai/exit_plan_mode', params })?.toolCallId,
    't1',
  );
  assert.equal(extractXaiExitPlanMarkdown(params), '# Plan');
  assert.equal(
    extractXaiExitPlanMarkdown({ sessionId: 's1', toolCallId: 't1' }),
    XAI_EMPTY_PLAN_MARKDOWN,
  );
  const captured = makeXaiExitPlanModeCapturedResponse();
  assert.equal(captured.outcome, 'abandoned');
});

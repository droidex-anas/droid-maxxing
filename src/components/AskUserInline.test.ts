import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuestionCard } from './AskUserInline.js';
import type { SessionQuestion } from '../types/bridge.js';

function makeQuestion(questions: SessionQuestion['questions']): SessionQuestion {
  return { appSessionId: 'app-1', requestId: 'req-1', questions };
}

function renderCard(question: SessionQuestion): string {
  return renderToStaticMarkup(
    createElement(QuestionCard, {
      question,
      onAnswer: () => undefined,
      onCancel: () => undefined,
    }),
  );
}

const SINGLE = makeQuestion([
  { index: 0, question: 'Which database should I use?', options: ['SQLite', 'Postgres'] },
]);

test('renders the question, every option, and a custom-answer row', () => {
  const html = renderCard(SINGLE);

  assert.match(html, /Which database should I use\?/);
  assert.match(html, />SQLite</);
  assert.match(html, />Postgres</);
  assert.match(html, /Type your own answer/);
});

test('options are toggle buttons and start unselected', () => {
  const html = renderCard(SINGLE);

  assert.ok(!html.includes('aria-pressed="true"'));
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
});

test('submit stays disabled until an answer exists', () => {
  const html = renderCard(SINGLE);

  assert.match(html, /<button[^>]*disabled=""[^>]*>Submit</);
});

test('a single question hides the step counter and Back', () => {
  const html = renderCard(SINGLE);

  assert.ok(!html.includes(' of '));
  assert.ok(!html.includes('>Back</button>'));
});

test('multiple questions show progress and a Next action', () => {
  const html = renderCard(
    makeQuestion([
      { index: 0, question: 'First?', options: ['a'] },
      { index: 1, question: 'Second?', options: ['b'] },
    ]),
  );

  // Adjacent text expressions render with SSR comment separators.
  assert.match(html, /1(?:<!-- -->)? of (?:<!-- -->)?2/);
  assert.match(html, />Next</);
  // Next stays disabled until the first question is answered.
  assert.match(html, /<button[^>]*disabled=""[^>]*>Next</);
});

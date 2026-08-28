import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { initialState, StaticStoreProvider, type AppState } from '../hooks/useStore';
import type { SessionSummary } from '../types/bridge';
import { ArchivedChatsSettings } from './ArchivedChatsSettings';
import { droidSessionConfiguration } from '../lib/sessionConfiguration';

function makeSession(appSessionId: string, title: string): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title,
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'off',
    }),
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function renderSection(state: AppState): string {
  return renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state, dispatch: () => undefined },
      createElement(ArchivedChatsSettings),
    ),
  );
}

test('archived chats are listed, deleted ones are not', () => {
  const state: AppState = {
    ...initialState,
    sessions: {
      a: makeSession('a', 'Refactor the parser'),
      b: makeSession('b', 'Old experiment'),
      c: makeSession('c', 'Normal chat'),
    },
    sessionOrder: ['a', 'b', 'c'],
    chatMetadata: {
      a: { archivedAt: 100 },
      b: { archivedAt: 200, deletedAt: 300 },
    },
  };
  const html = renderSection(state);
  assert.match(html, /Refactor the parser/);
  assert.doesNotMatch(html, /Old experiment/);
  assert.doesNotMatch(html, /Normal chat/);
  assert.match(html, /Restore/);
  assert.match(html, /Delete permanently/);
});

test('an empty archive renders the empty state', () => {
  const html = renderSection({
    ...initialState,
    sessions: { c: makeSession('c', 'Normal chat') },
    sessionOrder: ['c'],
  });
  assert.match(html, /No archived chats/);
});

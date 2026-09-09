import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeBrowserPermissionPrompt,
  settleBrowserPermissionPrompt,
} from './browserPermissionPromptCompletion';
import { browserPromptReducer, emptyBrowserPromptState } from './browserPermissionPromptState';

test('dismissed or superseded prompt settlements cannot resurrect a prompt or affect the next choice', () => {
  const prompt = {
    requestId: 'first',
    kind: 'warning' as const,
    title: 'Permission',
    message: 'Allow?',
    detail: '',
    buttons: ['Cancel', 'Allow'],
    cancelId: 0,
  };
  const shown = browserPromptReducer(emptyBrowserPromptState, { type: 'show', prompt });
  const pending = browserPromptReducer(shown, { type: 'choose', requestId: 'first' });
  const dismissed = browserPromptReducer(pending, { type: 'dismiss', requestId: 'first' });
  const failure = { type: 'settled' as const, requestId: 'first', error: 'Disconnected' };
  assert.equal(browserPromptReducer(dismissed, failure), dismissed);
  const next = browserPromptReducer(pending, {
    type: 'show',
    prompt: { ...prompt, requestId: 'next' },
  });
  const nextPending = browserPromptReducer(next, { type: 'choose', requestId: 'next' });
  assert.equal(browserPromptReducer(nextPending, failure), nextPending);
  assert.equal(
    browserPromptReducer(nextPending, { type: 'dismiss', requestId: 'first' }),
    nextPending,
  );
  assert.deepEqual(browserPromptReducer(pending, failure), {
    prompt,
    pending: null,
    error: 'Disconnected',
  });
});

test('browser permission approval waits for the trusted sheet to close and paint', async () => {
  const events: string[] = [];
  let finishPaint: (() => void) | undefined;
  const painted = new Promise<void>((resolve) => {
    finishPaint = resolve;
  });

  const completion = completeBrowserPermissionPrompt('prompt-1', 1, {
    close: () => events.push('closed'),
    waitForClosePaint: () => painted,
    resolve: async (requestId, response) => {
      events.push(`resolved:${requestId}:${String(response)}`);
      return true;
    },
  });

  assert.deepEqual(events, ['closed']);
  finishPaint?.();
  await completion;
  assert.deepEqual(events, ['closed', 'resolved:prompt-1:1']);
});

test('browser permission failure resolves to an actionable error instead of rejecting', async () => {
  const result = await settleBrowserPermissionPrompt('prompt-1', 1, {
    close: () => {},
    waitForClosePaint: async () => {},
    resolve: async () => {
      throw new Error('Bridge disconnected');
    },
  });

  assert.equal(result, 'Bridge disconnected');
});

test('browser permission choice stays open when the main process did not accept it', async () => {
  const result = await settleBrowserPermissionPrompt('prompt-stale', 1, {
    close: () => {},
    waitForClosePaint: async () => {},
    resolve: async () => false,
  });

  assert.equal(result, 'DROIDEX could not apply that choice.');
});

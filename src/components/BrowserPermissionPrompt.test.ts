import assert from 'node:assert/strict';
import test from 'node:test';
import { completeBrowserPermissionPrompt } from './browserPermissionPromptCompletion';

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
  const module = await import('./browserPermissionPromptCompletion');
  const settleBrowserPermissionPrompt = Reflect.get(module, 'settleBrowserPermissionPrompt');
  assert.equal(typeof settleBrowserPermissionPrompt, 'function');
  const result = await settleBrowserPermissionPrompt('prompt-1', 1, {
    close: () => {},
    waitForClosePaint: async () => {},
    resolve: async () => {
      throw new Error('Bridge disconnected');
    },
  });

  assert.equal(result, 'Bridge disconnected');
});

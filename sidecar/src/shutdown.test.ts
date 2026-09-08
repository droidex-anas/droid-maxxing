import assert from 'node:assert/strict';
import test from 'node:test';
import { shutdownSidecar } from './shutdown.js';

test('sidecar shutdown attempts every stage and reports the first failure', async () => {
  const calls: string[] = [];
  const firstError = new Error('session shutdown failed');

  await assert.rejects(
    shutdownSidecar({
      shutdownSessions: async () => {
        calls.push('sessions');
        throw firstError;
      },
      shutdownAutomations: async () => {
        calls.push('automations');
        throw new Error('automation shutdown failed');
      },
      disableMetrics: () => {
        calls.push('metrics');
        throw new Error('metrics shutdown failed');
      },
      closeBridge: async () => {
        calls.push('bridge');
        throw new Error('bridge shutdown failed');
      },
    }),
    (error) => error === firstError,
  );
  assert.deepEqual(calls, ['sessions', 'automations', 'metrics', 'bridge']);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { commitPrimaryPromptAfterBaseline } from './promptSend';

test('primary send echoes and clears before the git baseline, then sends after', async () => {
  const effects: string[] = [];
  let releaseBaseline = (): void => undefined;
  const baseline = new Promise<void>((resolve) => {
    releaseBaseline = resolve;
  });

  const committed = commitPrimaryPromptAfterBaseline({
    waitForBaseline: () => {
      effects.push('baseline-start');
      return baseline.then(() => {
        effects.push('baseline-done');
      });
    },
    appendTranscript: () => {
      effects.push('echo');
    },
    resetComposer: () => {
      effects.push('clear');
    },
    sendCommand: () => {
      effects.push('send');
    },
  });

  await Promise.resolve();
  assert.deepEqual(effects, ['echo', 'clear', 'baseline-start']);
  releaseBaseline();
  assert.equal(await committed, true);
  assert.deepEqual(effects, ['echo', 'clear', 'baseline-start', 'baseline-done', 'send']);
});

test('primary send keeps the echo when commit is aborted after the baseline', async () => {
  const effects: string[] = [];
  const committed = await commitPrimaryPromptAfterBaseline({
    waitForBaseline: async () => {
      effects.push('baseline');
    },
    canCommit: () => false,
    appendTranscript: () => {
      effects.push('echo');
    },
    resetComposer: () => {
      effects.push('clear');
    },
    sendCommand: () => {
      effects.push('send');
    },
  });

  assert.equal(committed, false);
  assert.deepEqual(effects, ['echo', 'clear', 'baseline']);
});

test('primary send with no baseline work still echoes before the command', async () => {
  const effects: string[] = [];
  await commitPrimaryPromptAfterBaseline({
    waitForBaseline: async () => undefined,
    appendTranscript: () => {
      effects.push('echo');
    },
    resetComposer: () => {
      effects.push('clear');
    },
    sendCommand: () => {
      effects.push('send');
    },
  });
  assert.deepEqual(effects, ['echo', 'clear', 'send']);
});

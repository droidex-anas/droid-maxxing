import assert from 'node:assert/strict';
import test from 'node:test';

import { composePrompt, isVisualizeCommand, parseSlashSkillInvocation } from './composePrompt';

test('one selected skill uses the provider-native slash invocation', () => {
  assert.equal(composePrompt('PR #100', ['review'], []), '/review PR #100');
  assert.equal(composePrompt('', ['review'], []), '/review');
  assert.equal(composePrompt('PR #100', ['review'], ['src/a.ts']), '/review PR #100\n\n@src/a.ts');
});

test('a typed slash invocation separates the exact catalog skill from its prompt', () => {
  const skills = [{ name: 'review' }, { name: 'semgrep' }];
  assert.deepEqual(parseSlashSkillInvocation('/review PR #100', skills), {
    skillName: 'review',
    prompt: 'PR #100',
  });
  assert.deepEqual(parseSlashSkillInvocation('/SEMGREP what is this for?', skills), {
    skillName: 'semgrep',
    prompt: 'what is this for?',
  });
  assert.equal(parseSlashSkillInvocation('/unknown leave this alone', skills), undefined);
});

test('multiple selected skills keep the explicit multi-skill instruction', () => {
  assert.equal(
    composePrompt('inspect this', ['review', 'semgrep'], []),
    'Use these skills: "review", "semgrep".\n\ninspect this',
  );
});

test('/visualize remains concise when the renderer composes the visible prompt', () => {
  const composed = composePrompt('/visualize compare renderer timings', [], []);

  assert.equal(composed, '/visualize compare renderer timings');
  assert.doesNotMatch(composed, /fenced `app` block/);
  assert.doesNotMatch(composed, /--app-background/);
});

test('/visualize without arguments remains the visible user command', () => {
  const composed = composePrompt('/visualize', [], []);

  assert.equal(composed, '/visualize');
});

test('/visualize remains an app command even when a provider skill has the same name', () => {
  assert.equal(isVisualizeCommand('/visualize chart these results'), true);
  assert.equal(isVisualizeCommand('/visualizer is a different prompt'), false);
});

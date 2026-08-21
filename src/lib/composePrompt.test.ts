import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composePrompt,
  isVisualizeCommand,
  parseSlashSkillInvocation,
  promptTextWithVisualize,
  submitCommandFor,
} from './composePrompt';

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

test('the Visualize chip sends exactly what typing the command sends', () => {
  assert.equal(
    promptTextWithVisualize('compare renderer timings', true),
    '/visualize compare renderer timings',
  );
  assert.equal(promptTextWithVisualize('', true), '/visualize');
  // Already typed: the chip must not double the command.
  assert.equal(promptTextWithVisualize('/visualize a histogram', true), '/visualize a histogram');
  assert.equal(promptTextWithVisualize('leave this alone', false), 'leave this alone');
});

test('/visualize remains an app command even when a provider skill has the same name', () => {
  assert.equal(isVisualizeCommand('/visualize chart these results'), true);
  assert.equal(isVisualizeCommand('/visualizer is a different prompt'), false);
});

test('an existing App keeps follow-up prompts App-capable without another slash command', async () => {
  type ResponseFormatForPrompt = (
    text: string,
    hasAppContext: boolean,
  ) => 'app-create' | 'app-followup' | undefined;
  const promptModule = (await import('./composePrompt')) as unknown as {
    responseFormatForPrompt?: ResponseFormatForPrompt;
  };
  const responseFormatForPrompt = promptModule.responseFormatForPrompt;
  assert.equal(typeof responseFormatForPrompt, 'function');
  if (!responseFormatForPrompt) return;

  assert.equal(responseFormatForPrompt('make the points larger', true), 'app-followup');
  assert.equal(responseFormatForPrompt('ordinary question', false), undefined);
  assert.equal(responseFormatForPrompt('/visualize a histogram', false), 'app-create');
});

const nothingStaged = { visualizeSelected: false, skillCount: 0, fileCount: 0 };

test('a bare command runs as a command, including the compact aliases', () => {
  assert.equal(submitCommandFor('/mission', nothingStaged), 'mission');
  for (const alias of ['/compact', '/compaction', '/compression']) {
    assert.equal(submitCommandFor(alias, nothingStaged), 'compact');
  }
  assert.equal(submitCommandFor('/compact this thread please', nothingStaged), null);
  assert.equal(submitCommandFor('what does /compact do?', nothingStaged), null);
});

// Skills and files already made the same words a prompt. Visualize did not, so
// staging it and typing /compact compacted the session and dropped the plugin.
test('anything staged makes the same words a prompt instead of a command', () => {
  assert.equal(submitCommandFor('/compact', { ...nothingStaged, visualizeSelected: true }), null);
  assert.equal(submitCommandFor('/mission', { ...nothingStaged, visualizeSelected: true }), null);
  assert.equal(submitCommandFor('/compact', { ...nothingStaged, skillCount: 1 }), null);
  assert.equal(submitCommandFor('/mission', { ...nothingStaged, fileCount: 1 }), null);
});

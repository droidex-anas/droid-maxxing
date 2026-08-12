import assert from 'node:assert/strict';
import test from 'node:test';

import { appPromptDisplayFromText, formatAppPrompt } from './appPrompt.js';

test('formatAppPrompt keeps the request recoverable and adds broad internal App guidance', () => {
  const prompt = formatAppPrompt('/visualize compare renderer timings');

  assert.match(prompt, /^DROIDEX App request:/);
  assert.match(prompt, /\/visualize compare renderer timings/);
  assert.match(prompt, /chart, diagram, timeline, calculator, simulator/);
  assert.match(prompt, /fenced `app` block/);
  assert.match(prompt, /--app-background/);
  assert.match(prompt, /transparent chat canvas/);
  assert.match(prompt, /Do not use network requests/);
});

test('appPromptDisplayFromText reveals only what the user typed', () => {
  const prompt = formatAppPrompt('/visualize compare renderer timings');

  assert.equal(appPromptDisplayFromText(prompt), '/visualize compare renderer timings');
  assert.equal(appPromptDisplayFromText('ordinary prompt'), null);
});

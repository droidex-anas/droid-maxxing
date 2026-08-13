import assert from 'node:assert/strict';
import test from 'node:test';

import { appPromptDisplayFromText, formatAppPrompt } from './appPrompt.js';

test('formatAppPrompt keeps the request recoverable and adds broad internal App guidance', () => {
  const prompt = formatAppPrompt('/visualize compare renderer timings', 'create');

  assert.match(prompt, /^DROIDEX App request:/);
  assert.match(prompt, /\/visualize compare renderer timings/);
  assert.match(prompt, /chart, diagram, timeline, calculator, simulator/);
  assert.match(prompt, /fenced `app` block/);
  assert.match(prompt, /--app-background/);
  assert.match(prompt, /transparent chat canvas/);
  assert.match(prompt, /transparent by default/);
  assert.match(
    prompt,
    /may intentionally give the whole App or selected regions soft theme-aware backgrounds/,
  );
  assert.match(prompt, /Avoid accidental hard black or white page slabs/);
  assert.doesNotMatch(prompt, /keep that region transparent and unframed/);
  assert.match(prompt, /data-droidex-app-root/);
  assert.match(prompt, /data-droidex-app-canvas/);
  assert.match(prompt, /no outer max-width, page padding, border, radius, or shadow/);
  assert.match(prompt, /data-latex/);
  assert.match(prompt, /window\.droidex\.renderMath/);
  assert.match(prompt, /responsive SVG/);
  assert.match(prompt, /bar, line, area, scatter, bubble/);
  assert.match(prompt, /mixed views/);
  assert.match(prompt, /color-blind-safe/);
  assert.match(prompt, /palette or series-color controls/);
  assert.match(prompt, /illustrations, annotated processes, infographics/);
  assert.match(prompt, /visual, inspector, controls, and explanation/);
  assert.match(prompt, /hover, click, touch, and keyboard/);
  assert.match(prompt, /Never clip axis titles, tick labels, legends, or annotations/);
  assert.match(prompt, /wireframes/);
  assert.match(prompt, /Do not use network requests/);
});

test('appPromptDisplayFromText reveals only what the user typed', () => {
  const prompt = formatAppPrompt('/visualize compare renderer timings', 'create');

  assert.equal(appPromptDisplayFromText(prompt), '/visualize compare renderer timings');
  assert.equal(appPromptDisplayFromText('ordinary prompt'), null);
});

test('a conversational App follow-up can revise the existing block without forcing one', () => {
  const prompt = formatAppPrompt('the hover interaction is not working, fix it', 'followup');

  assert.match(prompt, /chat already contains an interactive App/i);
  assert.match(prompt, /return a complete revised fenced `app` block/i);
  assert.match(prompt, /otherwise respond normally/i);
  assert.match(prompt, /the hover interaction is not working, fix it/);
});

test('explicit creation survives skill and file composition before sidecar formatting', () => {
  const composed = '/data-analysis /visualize compare the attached timings\n\n@timings.csv';
  const prompt = formatAppPrompt(composed, 'create');

  assert.match(prompt, /Build the most useful interactive in-chat App/);
  assert.doesNotMatch(prompt, /chat already contains an interactive App/i);
});

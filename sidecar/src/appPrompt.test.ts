import assert from 'node:assert/strict';
import test from 'node:test';

import { appPromptDisplayFromText, formatAppPrompt, hasAppFence } from './appPrompt.js';

test('hasAppFence recognizes the App answer shape the guidance asks for', () => {
  assert.equal(hasAppFence('Here it is.\n\n```app\n<main></main>\n```'), true);
  // Streaming or replay can hand over an answer whose fence is still open.
  assert.equal(hasAppFence('Here it is.\n\n```app\n<main>'), true);
  assert.equal(hasAppFence('```app\n<main></main>\n```'), true);
  assert.equal(hasAppFence('~~~~app\nbody'), true);
  assert.equal(hasAppFence('> ```app\n> <main></main>'), true);
  assert.equal(hasAppFence('- ```app\n  <main></main>'), true);
  // The renderer's scanner splits lines on \r?\n and strips any run of
  // blockquote or list prefixes, so the probe has to reach those shapes too.
  assert.equal(hasAppFence('Here it is.\r\n\r\n```app\r\n<main></main>\r\n```'), true);
  assert.equal(hasAppFence('- > ```app\n  > <main></main>'), true);
  assert.equal(hasAppFence('>\t```app\n>\t<main></main>'), true);
  assert.equal(hasAppFence('```app title=lab\n<main></main>\n```'), true);

  assert.equal(hasAppFence('```ts\nconst app = 1;\n```'), false);
  assert.equal(hasAppFence('```application\nnot an app fence\n```'), false);
  assert.equal(hasAppFence('the app fence lives inside prose ```app``` inline'), false);
  assert.equal(hasAppFence('no fences here at all'), false);
});

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
  assert.match(prompt, /give that outer surface a restrained radius and clip its contents/);
  assert.match(prompt, /Avoid accidental hard black or white page slabs/);
  assert.doesNotMatch(prompt, /keep that region transparent and unframed/);
  assert.match(prompt, /data-droidex-app-root/);
  assert.match(prompt, /data-droidex-app-canvas/);
  assert.match(prompt, /no outer max-width, page padding, border, or shadow/);
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
  assert.match(prompt, /verify that every inline script parses/);
  assert.match(prompt, /SVG or Canvas initialization runs without errors/);
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

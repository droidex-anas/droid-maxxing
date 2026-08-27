import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  commandPaletteFallback,
  missionControlFallback,
  pullRequestsFallback,
  settingsPanelFallback,
  utilityToolFallback,
} from '../lib/lazySurfaces';

test('lazy Suspense fallbacks render skeleton status regions', () => {
  assert.match(renderToStaticMarkup(settingsPanelFallback()), /Loading settings/);
  assert.match(renderToStaticMarkup(commandPaletteFallback()), /Loading command palette/);
  assert.match(renderToStaticMarkup(missionControlFallback()), /Loading mission control/);
  assert.match(renderToStaticMarkup(pullRequestsFallback()), /Loading pull requests/);
  assert.match(renderToStaticMarkup(utilityToolFallback('terminal')), /Loading utility workspace/);
  assert.match(renderToStaticMarkup(utilityToolFallback('files')), /Loading files/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { utilityToolFallback } from '../lib/lazySurfaces';
import {
  CommandPaletteSkeleton,
  MissionControlSkeleton,
  PullRequestsSkeleton,
  SettingsPanelSkeleton,
} from '../components/skeletons/WorkspaceSkeletons';

test('lazy Suspense fallbacks render skeleton status regions', () => {
  assert.match(renderToStaticMarkup(createElement(SettingsPanelSkeleton)), /Loading settings/);
  assert.match(
    renderToStaticMarkup(createElement(CommandPaletteSkeleton)),
    /Loading command palette/,
  );
  assert.match(
    renderToStaticMarkup(createElement(MissionControlSkeleton)),
    /Loading mission control/,
  );
  assert.match(renderToStaticMarkup(createElement(PullRequestsSkeleton)), /Loading pull requests/);
  assert.match(renderToStaticMarkup(utilityToolFallback('terminal')), /Loading utility workspace/);
  assert.match(renderToStaticMarkup(utilityToolFallback('files')), /Loading files/);
});

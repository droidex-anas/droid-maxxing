import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const APP_SOURCE = readFileSync('src/App.tsx', 'utf8');
const LAZY_SOURCE = readFileSync('src/lib/lazySurfaces.tsx', 'utf8');

const OPTIONAL_SURFACE_IMPORTS = [
  './components/SettingsPanel',
  './components/CommandPalette',
  './components/SpecWikiModal',
  './components/onboarding/OnboardingWizard',
  './components/MissionControl',
  './features/pull-requests/PullRequestsView',
  './components/environment/ReviewPanel',
  './components/browser/BrowserFocusWorkspace',
  './components/terminal/TerminalWorkspace',
  './components/files/FilesWorkspace',
] as const;

test('App keeps optional workspaces off the static import graph', () => {
  for (const importPath of OPTIONAL_SURFACE_IMPORTS) {
    assert.doesNotMatch(APP_SOURCE, new RegExp(`from '${importPath.replace('./', './')}'`));
    assert.doesNotMatch(APP_SOURCE, new RegExp(`from "${importPath.replace('./', './')}"`));
  }
});

test('lazy surface registry defines a loader for every optional workspace', () => {
  for (const key of [
    'settings',
    'commandPalette',
    'specWiki',
    'onboarding',
    'missionControl',
    'pullRequests',
    'review',
    'browser',
    'terminal',
    'files',
  ]) {
    assert.match(LAZY_SOURCE, new RegExp(`${key}:`));
  }
});

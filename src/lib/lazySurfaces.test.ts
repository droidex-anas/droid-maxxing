import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const APP_SOURCE = readFileSync('src/App.tsx', 'utf8');
const LAZY_SOURCE = readFileSync('src/lib/lazySurfaces.tsx', 'utf8');
const HOST_SOURCE = readFileSync('src/components/onboarding/OnboardingLazyHost.tsx', 'utf8');
const SETTINGS_SOURCE = readFileSync('src/components/SettingsPanel.tsx', 'utf8');

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

test('lazy surfaces expose one loader map for React.lazy and preloading', () => {
  assert.match(LAZY_SOURCE, /const lazySurfaceLoaders = \{/);
  assert.match(LAZY_SOURCE, /export const LAZY_SURFACE_LOADERS[^=]+= lazySurfaceLoaders/);
  assert.match(LAZY_SOURCE, /lazy\(lazySurfaceLoaders\.settings\)/);
  assert.doesNotMatch(LAZY_SOURCE, /LAZY_SURFACE_LOADERS: Record[\s\S]*import\('\.\./);
});

test('animation boundaries keep motion outside Suspense where exit must run', () => {
  // Settings owns AnimatePresence internally; App keeps the lazy panel mounted.
  assert.match(APP_SOURCE, /<Suspense fallback=\{null\}>\s*<LazySettingsPanel \/>/);
  assert.match(SETTINGS_SOURCE, /<AnimatePresence>/);

  // Mission Control clipPath transition wraps Suspense, not the other way around.
  assert.match(
    APP_SOURCE,
    /initial=\{\{ clipPath: 'inset\(0 100% 0 0\)'[\s\S]*<Suspense fallback=\{<MissionControlSkeleton \/>}>[\s\S]*<LazyMissionControl \/>/,
  );

  // Onboarding exit runs on a sync motion host that is the direct AnimatePresence child.
  assert.match(APP_SOURCE, /<AnimatePresence>[\s\S]*<OnboardingLazyHost/);
  assert.match(
    HOST_SOURCE,
    /<motion\.div[\s\S]*exit=\{\{ opacity: 0 \}\}[\s\S]*<Suspense fallback=\{<OnboardingSkeleton \/>}>/,
  );

  // Spec wiki keeps its modal AnimatePresence inside the always-mounted lazy surface.
  assert.match(APP_SOURCE, /<Suspense fallback=\{null\}>\s*<LazySpecWikiModal \/>/);
});

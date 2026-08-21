import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { initialState, StaticStoreProvider } from '../../../hooks/useStore';
import type { GithubSetupController } from '../../../hooks/useGithubSetup';
import { PrGithubSetupEmpty, PrWorkspaceEmpty } from './PrWorkspaceEmpty';

const signedOut = {
  installed: true,
  authenticated: false,
  installMethod: null,
} as const;

function setupController(overrides: Partial<GithubSetupController> = {}): GithubSetupController {
  return {
    availability: signedOut,
    action: 'idle',
    error: null,
    manualGuideOpened: false,
    authCode: null,
    isAuthPopoverOpen: false,
    isReady: false,
    refresh: () => undefined,
    runPrimaryAction: () => undefined,
    showAuthPrompt: () => undefined,
    closeAuthPrompt: () => undefined,
    cancelAuthentication: () => undefined,
    ...overrides,
  };
}

function renderSetup(overrides: Partial<GithubSetupController> = {}): string {
  return renderToStaticMarkup(
    createElement(PrGithubSetupEmpty, { setup: setupController(overrides) }),
  );
}

test('authenticating with a device code shows the existing prompt, not a dead button', () => {
  const html = renderSetup({
    action: 'authenticating',
    authCode: 'ABCD-7HJK',
    isAuthPopoverOpen: true,
  });

  assert.match(html, /ABCD-7HJK/);
  assert.match(html, /Enter this code on GitHub/);
  assert.match(html, /Copy code/);
  assert.match(html, /Cancel sign-in/);
  assert.doesNotMatch(html, /Show sign-in code/);
  assert.doesNotMatch(html, /Waiting for GitHub/);
});

test('authenticating without a device code keeps an explicit cancellation action', () => {
  const html = renderSetup({ action: 'authenticating' });

  assert.match(html, /Waiting for GitHub…/);
  assert.match(html, /Cancel sign-in/);
  assert.doesNotMatch(html, /ABCD-7HJK/);
});

test('idle signed-out setup still uses the primary sign-in action', () => {
  const html = renderSetup();

  assert.match(html, /Sign in to GitHub/);
  assert.doesNotMatch(html, /Enter this code on GitHub/);
  assert.doesNotMatch(html, /Cancel sign-in/);
});

test('manual installation does not offer a nonfunctional cancellation action', () => {
  const html = renderSetup({
    availability: {
      installed: false,
      authenticated: false,
      installMethod: 'manual',
    },
    action: 'installing',
  });

  assert.match(html, /Installing…/);
  assert.doesNotMatch(html, /Cancel installation/);
});

test('setup errors are announced when they change', () => {
  const html = renderSetup({ error: 'GitHub CLI setup failed' });

  assert.match(html, /aria-live="polite"/);
  assert.match(html, /GitHub CLI setup failed/);
});

test('a non-GitHub binding offers a replacement workspace action', () => {
  const html = renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state: initialState, dispatch: () => undefined },
      createElement(PrWorkspaceEmpty, {
        cwd: '/removed-repository',
        gitLoaded: true,
        isGitHub: false,
        setup: setupController(),
      }),
    ),
  );

  assert.match(html, /This folder is not a GitHub repository\./);
  assert.match(html, /Choose another workspace/);
});

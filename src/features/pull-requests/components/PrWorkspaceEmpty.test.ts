import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GithubSetupController } from '../../../hooks/useGithubSetup';
import { PrGithubSetupEmpty } from './PrWorkspaceEmpty';

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

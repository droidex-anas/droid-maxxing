import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { initialState, StaticStoreProvider, type AppState } from '../hooks/useStore.js';
import type { Autonomy, ModelInfo, ReasoningEffort, SessionSummary } from '../types/bridge.js';
import RightPanel from './RightPanel.js';
import { EnvironmentSection } from './environment/EnvironmentSection.js';
import type { GithubAvailability, GitEnvironment, PullRequest } from '../types/vcs.js';
import { droidSessionConfiguration } from '../lib/sessionConfiguration';

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  appSessionId: 's1',
  sessionPurpose: 'chat',
  role: 'primary',
  title: 's1',
  goal: 's1',
  cwd: '/workspace',
  configuration: droidSessionConfiguration({
    modelId: 'model-default',
    interactionMode: 'auto',
    autonomy: 'medium',
  }),
  phase: 'paused',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const model = (overrides: Partial<ModelInfo>): ModelInfo => ({
  id: 'm1',
  displayName: 'Model Alpha',
  isCustom: false,
  ...overrides,
});

function renderPanel(
  config: {
    modelId: string;
    reasoningEffort?: ReasoningEffort;
    autonomy?: Autonomy;
  },
  models: ModelInfo[],
  globalReasoning: ReasoningEffort = 'high',
): string {
  const active = session({
    configuration: droidSessionConfiguration({
      modelId: config.modelId,
      interactionMode: 'auto',
      autonomy: config.autonomy ?? 'medium',
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    }),
  });
  const state: AppState = {
    ...initialState,
    sessions: { [active.appSessionId]: active },
    sessionOrder: [active.appSessionId],
    activeAppSessionId: active.appSessionId,
    models,
    agentConfig: {
      ...initialState.agentConfig,
      primary: { ...initialState.agentConfig.primary, reasoning: globalReasoning },
    },
  };
  return renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state, dispatch: () => undefined },
      createElement(RightPanel),
    ),
  );
}

test('model row shows the session-pinned reasoning effort, never autonomy', () => {
  const html = renderPanel({ autonomy: 'medium', reasoningEffort: 'xhigh', modelId: 'm1' }, [
    model({ supportedReasoningEfforts: ['low', 'xhigh'] }),
  ]);
  assert.match(html, /Model Alpha/);
  assert.match(html, />xhigh</);
  assert.doesNotMatch(html, />medium</);
});

test('model row falls back to the global default effort', () => {
  const html = renderPanel(
    { modelId: 'm1' },
    [model({ supportedReasoningEfforts: ['max'] })],
    'max',
  );
  assert.match(html, />max</);
});

test('model row hides the pill for a known model without reasoning support', () => {
  const html = renderPanel({ reasoningEffort: 'xhigh', modelId: 'm1' }, [
    model({ supportedReasoningEfforts: [] }),
  ]);
  assert.match(html, /Model Alpha/);
  assert.doesNotMatch(html, />xhigh</);
});

test('model row keeps the pill while the model list has not loaded', () => {
  const html = renderPanel({ reasoningEffort: 'xhigh', modelId: 'unlisted' }, []);
  assert.match(html, />xhigh</);
});

test('PR detection and Context setup share authenticated GitHub readiness', () => {
  const action = () => undefined;
  const env: GitEnvironment = {
    isRepo: true,
    isGitHub: true,
    branch: 'hotfix/review',
    detached: false,
    ahead: 0,
  };
  const renderEnvironment = (githubReady: boolean, availability: GithubAvailability) =>
    renderToStaticMarkup(
      createElement(
        StaticStoreProvider,
        { state: initialState, dispatch: action },
        createElement(EnvironmentSection, {
          cwd: '/workspace',
          env,
          branches: null,
          worktrees: [],
          diffStat: null,
          diffMode: 'worktree',
          onDiffModeChange: action,
          refresh: action,
          live: false,
          githubAvailability: availability,
          githubAction: 'idle',
          githubError: null,
          githubManualGuideOpened: false,
          githubAuthCode: null,
          githubAuthPopoverOpen: false,
          githubReady,
          onGithubSetupAction: action,
          onShowGithubAuthPrompt: action,
          onCloseGithubAuthPrompt: action,
          onCancelGithubAuthentication: action,
          pr: null,
          onOpenPr: action,
          onOpenReview: action,
        }),
      ),
    );
  const blockedHtml = renderEnvironment(false, {
    installed: true,
    authenticated: false,
    installMethod: null,
  });
  assert.match(blockedHtml, /Connect GitHub/);
  assert.doesNotMatch(blockedHtml, />Open PR</);

  const readyHtml = renderEnvironment(true, {
    installed: true,
    authenticated: true,
    installMethod: null,
  });
  assert.match(readyHtml, />Open PR</);
});

test('Context shows the Environment PR row and does not host the old PR panel', () => {
  const action = () => undefined;
  const env: GitEnvironment = {
    isRepo: true,
    isGitHub: true,
    branch: 'hotfix/review',
    detached: false,
    ahead: 0,
  };
  const pr: PullRequest = {
    number: 78,
    title: 'Improve PR details',
    state: 'OPEN',
    url: 'https://example.test/pull/78',
    isDraft: false,
    headRefName: 'feature',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    createdAt: '2026-08-04T10:00:00Z',
    updatedAt: '2026-08-04T10:00:00Z',
    author: 'author',
    reviewRequests: [],
    reviews: [],
  };
  const environmentHtml = renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state: initialState, dispatch: action },
      createElement(EnvironmentSection, {
        cwd: '/workspace',
        env,
        branches: null,
        worktrees: [],
        diffStat: null,
        diffMode: 'worktree',
        onDiffModeChange: action,
        refresh: action,
        live: false,
        githubAvailability: {
          installed: true,
          authenticated: true,
          installMethod: null,
        },
        githubAction: 'idle',
        githubError: null,
        githubManualGuideOpened: false,
        githubAuthCode: null,
        githubAuthPopoverOpen: false,
        githubReady: true,
        onGithubSetupAction: action,
        onShowGithubAuthPrompt: action,
        onCloseGithubAuthPrompt: action,
        onCancelGithubAuthentication: action,
        pr,
        onOpenPr: action,
        onOpenReview: action,
      }),
    ),
  );
  assert.match(environmentHtml, /#78/);
  assert.doesNotMatch(environmentHtml, /Comment on this PR…/);

  const contextHtml = renderPanel({ modelId: 'm1' }, [model()]);
  assert.match(contextHtml, /Context/);
  assert.doesNotMatch(contextHtml, /Comment on this PR…/);
});

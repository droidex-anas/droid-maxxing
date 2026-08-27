import { lazy } from 'react';
import type { UtilityTool } from './utilityPanel';
import {
  CommandPaletteSkeleton,
  MissionControlSkeleton,
  OnboardingSkeleton,
  PanelSkeleton,
  PullRequestsSkeleton,
  SettingsPanelSkeleton,
  UtilityPaneSkeleton,
} from '../components/skeletons/WorkspaceSkeletons';

export const LazySettingsPanel = lazy(() => import('../components/SettingsPanel'));
export const LazyCommandPalette = lazy(() => import('../components/CommandPalette'));
export const LazySpecWikiModal = lazy(() => import('../components/SpecWikiModal'));
export const LazyOnboardingWizard = lazy(() => import('../components/onboarding/OnboardingWizard'));
export const LazyMissionControl = lazy(() => import('../components/MissionControl'));
export const LazyPullRequestsView = lazy(async () => {
  const module = await import('../features/pull-requests/PullRequestsView');
  return { default: module.PullRequestsView };
});
export const LazyReviewPanel = lazy(async () => {
  const module = await import('../components/environment/ReviewPanel');
  return { default: module.ReviewPanel };
});
export const LazyBrowserFocusWorkspace = lazy(async () => {
  const module = await import('../components/browser/BrowserFocusWorkspace');
  return { default: module.BrowserFocusWorkspace };
});
export const LazyTerminalWorkspace = lazy(async () => {
  const module = await import('../components/terminal/TerminalWorkspace');
  return { default: module.TerminalWorkspace };
});
export const LazyFilesWorkspace = lazy(async () => {
  const module = await import('../components/files/FilesWorkspace');
  return { default: module.FilesWorkspace };
});

export function settingsPanelFallback() {
  return <SettingsPanelSkeleton />;
}

export function commandPaletteFallback() {
  return <CommandPaletteSkeleton />;
}

export function onboardingFallback() {
  return <OnboardingSkeleton />;
}

export function missionControlFallback() {
  return <MissionControlSkeleton />;
}

export function pullRequestsFallback() {
  return <PullRequestsSkeleton />;
}

export function utilityToolFallback(tool: UtilityTool) {
  switch (tool) {
    case 'review':
      return <PanelSkeleton title="review" />;
    case 'browser':
      return <PanelSkeleton title="browser" />;
    case 'terminal':
      return <UtilityPaneSkeleton />;
    case 'files':
      return <PanelSkeleton title="files" />;
  }
}

export type LazySurface =
  | 'settings'
  | 'commandPalette'
  | 'specWiki'
  | 'onboarding'
  | 'missionControl'
  | 'pullRequests'
  | 'review'
  | 'browser'
  | 'terminal'
  | 'files';

export const LAZY_SURFACE_LOADERS: Record<LazySurface, () => Promise<unknown>> = {
  settings: () => import('../components/SettingsPanel'),
  commandPalette: () => import('../components/CommandPalette'),
  specWiki: () => import('../components/SpecWikiModal'),
  onboarding: () => import('../components/onboarding/OnboardingWizard'),
  missionControl: () => import('../components/MissionControl'),
  pullRequests: () => import('../features/pull-requests/PullRequestsView'),
  review: () => import('../components/environment/ReviewPanel'),
  browser: () => import('../components/browser/BrowserFocusWorkspace'),
  terminal: () => import('../components/terminal/TerminalWorkspace'),
  files: () => import('../components/files/FilesWorkspace'),
};

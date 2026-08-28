import { lazy } from 'react';
import type { UtilityTool } from './utilityPanel';
import { PanelSkeleton, UtilityPaneSkeleton } from '../components/skeletons/WorkspaceSkeletons';

export const LAZY_SURFACE_LOADERS = {
  settings: () => import('../components/SettingsPanel'),
  commandPalette: () => import('../components/CommandPalette'),
  specWiki: () => import('../components/SpecWikiModal'),
  onboarding: () => import('../components/onboarding/OnboardingWizard'),
  missionControl: () => import('../components/MissionControl'),
  pullRequests: async () => {
    const module = await import('../features/pull-requests/PullRequestsView');
    return { default: module.PullRequestsView };
  },
  review: async () => {
    const module = await import('../components/environment/ReviewPanel');
    return { default: module.ReviewPanel };
  },
  browser: async () => {
    const module = await import('../components/browser/BrowserFocusWorkspace');
    return { default: module.BrowserFocusWorkspace };
  },
  terminal: async () => {
    const module = await import('../components/terminal/TerminalWorkspace');
    return { default: module.TerminalWorkspace };
  },
  files: async () => {
    const module = await import('../components/files/FilesWorkspace');
    return { default: module.FilesWorkspace };
  },
};

export type LazySurface = keyof typeof LAZY_SURFACE_LOADERS;

export const LazySettingsPanel = lazy(LAZY_SURFACE_LOADERS.settings);
export const LazyCommandPalette = lazy(LAZY_SURFACE_LOADERS.commandPalette);
export const LazySpecWikiModal = lazy(LAZY_SURFACE_LOADERS.specWiki);
export const LazyOnboardingWizard = lazy(LAZY_SURFACE_LOADERS.onboarding);
export const LazyMissionControl = lazy(LAZY_SURFACE_LOADERS.missionControl);
export const LazyPullRequestsView = lazy(LAZY_SURFACE_LOADERS.pullRequests);
export const LazyReviewPanel = lazy(LAZY_SURFACE_LOADERS.review);
export const LazyBrowserFocusWorkspace = lazy(LAZY_SURFACE_LOADERS.browser);
export const LazyTerminalWorkspace = lazy(LAZY_SURFACE_LOADERS.terminal);
export const LazyFilesWorkspace = lazy(LAZY_SURFACE_LOADERS.files);

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

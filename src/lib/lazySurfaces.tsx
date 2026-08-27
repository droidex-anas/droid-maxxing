import { lazy } from 'react';
import type { UtilityTool } from './utilityPanel';
import { PanelSkeleton, UtilityPaneSkeleton } from '../components/skeletons/WorkspaceSkeletons';

const lazySurfaceLoaders = {
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

export type LazySurface = keyof typeof lazySurfaceLoaders;

export const LAZY_SURFACE_LOADERS = lazySurfaceLoaders;

export const LazySettingsPanel = lazy(lazySurfaceLoaders.settings);
export const LazyCommandPalette = lazy(lazySurfaceLoaders.commandPalette);
export const LazySpecWikiModal = lazy(lazySurfaceLoaders.specWiki);
export const LazyOnboardingWizard = lazy(lazySurfaceLoaders.onboarding);
export const LazyMissionControl = lazy(lazySurfaceLoaders.missionControl);
export const LazyPullRequestsView = lazy(lazySurfaceLoaders.pullRequests);
export const LazyReviewPanel = lazy(lazySurfaceLoaders.review);
export const LazyBrowserFocusWorkspace = lazy(lazySurfaceLoaders.browser);
export const LazyTerminalWorkspace = lazy(lazySurfaceLoaders.terminal);
export const LazyFilesWorkspace = lazy(lazySurfaceLoaders.files);

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

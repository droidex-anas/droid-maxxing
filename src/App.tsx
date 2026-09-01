import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { shallowEqual, useStoreApi, useStoreDispatch, useStoreSelector } from './hooks/useStore';
import { AnimatePresence, motion } from 'framer-motion';
import { PanelLeft, PanelRight } from 'lucide-react';
import { bridge } from './lib/bridge';
import {
  connect,
  listFactoryDefaults,
  loadSessionHistory,
  sendNativeBrowserResult,
  openChild,
  newChildOpenRequestId,
} from './lib/commands';
import { isEmbedded } from './lib/embed';
import { getApiKey, setAppIcon } from './lib/desktop';
import { performNativeBrowserRequest } from './lib/nativeBrowserAgent';
import {
  browserKeyForSession,
  nativeBrowserRequestTargetsActiveSession,
} from './lib/browserSessionIdentity';
import { shouldOpenSelectedChild } from './lib/childSessions';
import type { ChildAccess } from './hooks/storeChildSession';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import PromptInput from './components/PromptInput';
import RightPanel from './components/RightPanel';
import EditorOpenMenu from './components/EditorOpenMenu';
import Toaster from './components/Toaster';
import { useRepoStatus } from './hooks/useRepoStatus';
import { useDocumentVisible } from './hooks/useDocumentVisible';
import { applyTheme, findPreset, resolveVariant } from './lib/theme';
import { useOnboarding, shouldShowOnboarding, hasSetupBlocker } from './hooks/useOnboarding';
import SetupBanner from './components/onboarding/SetupBanner';
import RuntimeStatusBanner from './components/RuntimeStatusBanner';
import { updateCli } from './lib/commands';
import { checkForAppUpdateAutomatically, startAutomaticAppUpdateChecks } from './lib/appUpdate';
import { toast } from './lib/toast';
import { UtilityPane } from './components/utility/UtilityPane';
import { closeTerminalForTab } from './lib/terminal';
import { utilityPanelForSession, type UtilityTool } from './lib/utilityPanel';
import { isTerminalInputTarget, isTerminalTabShortcut } from './lib/keyboardShortcuts';
import { useSessionWorkingDirectory } from './hooks/useSessionWorkingDirectory';
import { useDiagnosticsContext } from './hooks/useDiagnosticsContext';
import { useFinishNotifications } from './hooks/useFinishNotifications';
import { useWorkspaceScopes } from './hooks/useWorkspaceScopes';
import { useWorkspaceSessionList } from './hooks/useWorkspaceSessionList';
import { useHistoryIndexingIdle } from './hooks/useHistoryIndexingIdle';
import { useBackgroundWorkTier } from './hooks/useBackgroundWorkTier';
import { transcriptRehydrationLimit } from './lib/transcriptStoreMemory';
import {
  bindLazySurfaceIntent,
  scheduleIdleLazyWarmup,
  cancelIdleLazyWarmup,
} from './lib/chunkPreloader';
import { OnboardingLazyHost } from './components/onboarding/OnboardingLazyHost';
import { SettingsLazyHost } from './components/SettingsLazyHost';
import {
  CommandPaletteSkeleton,
  MissionControlSkeleton,
  PullRequestsSkeleton,
} from './components/skeletons/WorkspaceSkeletons';
import {
  LazyBrowserFocusWorkspace,
  LazyCommandPalette,
  LazyFilesWorkspace,
  LazyMissionControl,
  LazyPullRequestsView,
  LazyReviewPanel,
  LazySpecWikiModal,
  LazyTerminalWorkspace,
  utilityToolFallback,
} from './lib/lazySurfaces';
import { noteComposerNotApplicable, noteFirstMeaningfulShellPaint } from './lib/rendererPerf';

function ContextListIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={className}
    >
      <circle cx="5" cy="8" r="1.6" />
      <line x1="10" y1="8" x2="19" y2="8" />
      <circle cx="5" cy="16" r="1.6" />
      <line x1="10" y1="16" x2="19" y2="16" />
    </svg>
  );
}

const UTILITY_PANE_MIN = 420;
const UTILITY_PANE_MAX = 980;
const UTILITY_PANE_DEFAULT = 560;
const UTILITY_PANE_CONTENT_RESERVE = 520;
const UTILITY_PANE_WIDTH_STORAGE_KEY = 'droid-utility-pane-width';

// selectedChild can outlive its childAccess entry after failed/closed cleanup
// (withoutChildAccess deletes the parent key). Record indexing types that as
// always present; this runtime-safe lookup returns undefined instead of throwing.
function childAccessForSelection(
  childAccess: Record<string, Record<string, ChildAccess>>,
  parentAppSessionId: string,
  childSessionId: string,
): ChildAccess | undefined {
  if (!Object.hasOwn(childAccess, parentAppSessionId)) return undefined;
  return childAccess[parentAppSessionId][childSessionId];
}

export default function App() {
  const dispatch = useStoreDispatch();
  const store = useStoreApi();
  const state = useStoreSelector((current) => {
    const activeSession = current.activeAppSessionId
      ? current.sessions[current.activeAppSessionId]
      : null;
    return {
      activeSession,
      childAccess: current.childAccess,
      commandPaletteOpen: current.commandPaletteOpen,
      customThemes: current.customThemes,
      hasSessionContent: Boolean(
        activeSession && (current.transcripts[activeSession.appSessionId] ?? []).length > 0,
      ),
      historyLoaded: current.historyLoaded,
      mainView: current.mainView,
      rightPanelOpen: current.rightPanelOpen,
      selectedChild: current.selectedChild,
      sessionRestore: current.sessionRestore,
      settingsOpen: current.settingsOpen,
      sidebarCollapsed: current.sidebarCollapsed,
      theme: current.theme,
      utilityPanels: current.utilityPanels,
      workspaceCwds: current.workspaceCwds,
    };
  }, shallowEqual);
  const embedded = isEmbedded();
  const onboard = useOnboarding();
  useDiagnosticsContext();
  useHistoryIndexingIdle();
  useBackgroundWorkTier();
  const [forceWizard, setForceWizard] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [expandedBrowserAppSessionId, setExpandedBrowserAppSessionId] = useState<string | null>(
    null,
  );
  const cliLaunchHandled = useRef(false);
  const appUpdateLaunchCheckHandled = useRef(false);
  const showWizard =
    !embedded && onboard.ready && (forceWizard || shouldShowOnboarding(onboard.onboarding));
  // Desktop-only: toast when a model turn finishes (snippet + optional sound).
  useFinishNotifications(!embedded && !showWizard);
  const activeSession = state.activeSession;
  const workingDirectory = useSessionWorkingDirectory(activeSession);
  const repoStatus = useRepoStatus(workingDirectory);
  const documentVisible = useDocumentVisible();
  const setCanonicalWorkspaceCwds = useCallback(
    (cwds: string[]) => {
      dispatch({ type: 'SET_WORKSPACE_CWDS', cwds });
    },
    [dispatch],
  );
  const { scopes: workspaceScopes, ready: workspaceScopesReady } = useWorkspaceScopes(
    state.workspaceCwds,
    !embedded && documentVisible,
    setCanonicalWorkspaceCwds,
  );
  const showEarlierSessions = useWorkspaceSessionList(
    workspaceScopes,
    !embedded && workspaceScopesReady,
  );
  // Mission Control is active only for a session explicitly created for it,
  // not merely because the compose preview is open.
  const isMissionControlView = activeSession?.sessionPurpose === 'mission-control';
  const utilityPanel = utilityPanelForSession(state.utilityPanels, activeSession?.appSessionId);
  const activeUtilityTab =
    utilityPanel.tabs.find((tab) => tab.id === utilityPanel.activeTabId) ?? null;
  const showUtilityPane = !embedded && !!activeSession && utilityPanel.open && !showWizard;
  // The pull request workspace owns the whole content area and the top-right
  // corner of its own toolbar, so the session-scoped overlays (Context panel)
  // and floating window buttons stay out of it instead of covering its header.
  const prWorkspaceView = !embedded && state.mainView === 'pull-requests';
  // An expanded browser covers the full content row, which would leave the pull
  // request workspace hidden and non-interactive behind it. The expansion stays
  // owned by the browser pane; this view simply does not take part in it.
  const browserExpanded =
    !!activeSession &&
    showUtilityPane &&
    !prWorkspaceView &&
    activeUtilityTab?.tool === 'browser' &&
    expandedBrowserAppSessionId === activeSession.appSessionId;
  const focused = isMissionControlView;
  // A normal/spec session only has something worth showing once a message has
  // been sent (the first transcript is seeded from the opening prompt).
  const hasSessionContent = state.hasSessionContent;
  // The context toggle is meaningful in Mission Control (always) and in a normal
  // chat only after it has content; otherwise there is nothing to open.
  const canToggleContext = isMissionControlView || hasSessionContent;
  // The context panel floats *over* the chat as an overlay (it does not shrink
  // the main scroll area), so the page scrollbar stays pinned to the window's
  // right edge instead of sliding inward and looking like a divider.
  const rightPanelVisible =
    !focused && !prWorkspaceView && !showUtilityPane && state.rightPanelOpen && hasSessionContent;
  const requestedHistory = useRef(new Set<string>());
  const [utilityPaneWidth, setUtilityPaneWidth] = useState(() => initialUtilityPaneWidth());
  const [utilityPaneMax, setUtilityPaneMax] = useState(() => utilityPaneMaxWidth());
  const contentRowRef = useRef<HTMLDivElement>(null);
  const [contentRowWidth, setContentRowWidth] = useState(0);
  const utilityPaneToggleRef = useRef<HTMLButtonElement>(null);
  const shellPaintMarked = useRef(false);
  const composerStartupResolved = useRef(false);

  useEffect(() => {
    if (shellPaintMarked.current) return;
    shellPaintMarked.current = true;
    const raf = requestAnimationFrame;
    raf(() => {
      noteFirstMeaningfulShellPaint();
      scheduleIdleLazyWarmup();
    });
    return () => {
      cancelIdleLazyWarmup();
    };
  }, []);

  useEffect(() => {
    if (composerStartupResolved.current) return;
    if (!isMissionControlView && !prWorkspaceView) return;
    composerStartupResolved.current = true;
    noteComposerNotApplicable();
  }, [isMissionControlView, prWorkspaceView]);

  useEffect(() => {
    const toggle = utilityPaneToggleRef.current;
    if (!toggle || showUtilityPane) return;
    const cleanups = [
      bindLazySurfaceIntent('browser', toggle),
      bindLazySurfaceIntent('files', toggle),
      bindLazySurfaceIntent('terminal', toggle),
      bindLazySurfaceIntent('review', toggle),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [showUtilityPane]);

  const toggleRightPanel = useCallback(() => {
    const open = !state.rightPanelOpen;
    dispatch({ type: 'SET_RIGHT_PANEL', open });
  }, [dispatch, state.rightPanelOpen]);

  const toggleUtilityPane = useCallback(() => {
    dispatch({ type: 'SET_UTILITY_PANEL_OPEN', open: !utilityPanel.open });
  }, [dispatch, utilityPanel.open]);

  const openUtilityTool = useCallback(
    (tool: UtilityTool) => {
      dispatch({
        type: 'OPEN_UTILITY_TOOL',
        tool,
        tabId: tool === 'terminal' ? crypto.randomUUID() : undefined,
        cwd: tool === 'terminal' ? workingDirectory : undefined,
      });
    },
    [dispatch, workingDirectory],
  );

  useEffect(() => {
    const onResize = () => {
      const available = contentRowRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      setUtilityPaneMax(utilityPaneMaxWidth(available));
      setUtilityPaneWidth((width) => clampUtilityPane(width, available));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    const node = contentRowRef.current;
    if (!node) return;
    const update = () => {
      const available = Math.round(node.getBoundingClientRect().width);
      setContentRowWidth(available);
      setUtilityPaneMax(utilityPaneMaxWidth(available));
      setUtilityPaneWidth((width) => clampUtilityPane(width, available));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (documentVisible) root.removeAttribute('data-window-hidden');
    else root.setAttribute('data-window-hidden', 'true');
    return () => {
      root.removeAttribute('data-window-hidden');
    };
  }, [documentVisible]);

  useEffect(() => {
    if (embedded) return;
    void setAppIcon(state.theme.appIconMode).catch((error: unknown) => {
      console.error('Failed to update app icon', error);
    });
  }, [embedded, state.theme.appIconMode]);

  useEffect(() => {
    if (state.theme.mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      // Follow the OS scheme with the active preset's matching variant.
      // Hand-edited (custom) colors have no second variant, so they stay put.
      const preset = findPreset(state.theme.presetId, state.customThemes);
      if (preset) dispatch({ type: 'SET_THEME', theme: resolveVariant(preset, 'system') });
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, [state.theme.mode, state.theme.presetId, state.customThemes, dispatch]);

  useEffect(() => {
    if (embedded) return;
    void (async () => {
      // Bridge info and the saved API key are independent IPCs; fetch them
      // together so the connect command reaches the sidecar one round-trip
      // sooner. Queued commands flush in order once the socket opens.
      const [, key] = await Promise.all([bridge.start(), getApiKey()]);
      connect(key ?? '');
      listFactoryDefaults();
    })();
  }, [embedded]);

  // App update discovery must never wait on CLI/env probing: that work can be
  // slow or unavailable, while the verified appcast is independent.
  useEffect(() => {
    if (embedded) return;
    if (!onboard.ready || !onboard.onboarding?.completed) return;
    if (onboard.onboarding.appAutoUpdate === false) return;
    return startAutomaticAppUpdateChecks(() => {
      const resumeDeferred = !appUpdateLaunchCheckHandled.current;
      appUpdateLaunchCheckHandled.current = true;
      void checkForAppUpdateAutomatically(resumeDeferred);
    });
  }, [embedded, onboard.ready, onboard.onboarding?.completed, onboard.onboarding?.appAutoUpdate]);

  // Optional CLI maintenance still waits for environment detection, but it no
  // longer gates app update discovery or the sidebar update button.
  useEffect(() => {
    if (embedded || cliLaunchHandled.current) return;
    if (!onboard.ready || !onboard.onboarding?.completed) return;
    // Defer until env detection lands so the CLI auto-update isn't skipped by a
    // race where this runs before `env` arrives.
    const wantsCliAutoUpdate = onboard.onboarding.cliAutoUpdate !== false;
    if (wantsCliAutoUpdate && !onboard.env) return;
    cliLaunchHandled.current = true;
    if (wantsCliAutoUpdate && onboard.env?.cli.present) {
      updateCli(onboard.onboarding.installChannel);
    }
  }, [embedded, onboard.ready, onboard.onboarding, onboard.env]);

  // Surface the result of a background CLI update.
  useEffect(() => {
    if (onboard.lastResult?.phase !== 'update') return;
    if (onboard.lastResult.ok) toast.success('Droid CLI is up to date.');
  }, [onboard.lastResult]);

  // The native browser is a separate Electron layer that floats above the DOM,
  // so close it while the full-screen wizard is up or it paints over the tour.
  useEffect(() => {
    if (showWizard && utilityPanel.open) dispatch({ type: 'SET_UTILITY_PANEL_OPEN', open: false });
  }, [showWizard, utilityPanel.open, dispatch]);

  // "Run setup again" from Settings re-opens the tour.
  useEffect(() => {
    const onOpen = () => {
      setBannerDismissed(false);
      setForceWizard(true);
    };
    window.addEventListener('droid:open-onboarding', onOpen);
    return () => {
      window.removeEventListener('droid:open-onboarding', onOpen);
    };
  }, []);

  useEffect(() => {
    if (embedded) return;
    const unsub = bridge.subscribe((event) => {
      if (event.type !== 'browser.native.request') return;
      const current = store.getState();
      const activeBrowserKey = browserKeyForSession(
        current.activeAppSessionId ? current.sessions[current.activeAppSessionId] : undefined,
      );
      const requestIsForActiveChat = nativeBrowserRequestTargetsActiveSession(
        activeBrowserKey,
        event.request.appSessionId,
      );
      if (event.request.action === 'open' && requestIsForActiveChat) {
        dispatch({ type: 'SET_RIGHT_PANEL', open: false });
        dispatch({ type: 'OPEN_UTILITY_TOOL', tool: 'browser' });
      }
      void performNativeBrowserRequest(event.request)
        .then(sendNativeBrowserResult)
        .catch((err: unknown) => {
          sendNativeBrowserResult({
            requestId: event.request.requestId,
            appSessionId: event.request.appSessionId,
            browserSessionId: event.request.browserSessionId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
    return () => {
      unsub();
    };
  }, [dispatch, embedded, store]);

  useEffect(() => {
    if (embedded) return;
    if (!activeSession) return;
    const appSessionId = activeSession.appSessionId;
    if (state.historyLoaded[appSessionId]) {
      requestedHistory.current.delete(appSessionId);
      return;
    }
    const restore = state.sessionRestore[appSessionId];
    if (restore?.status === 'failed') {
      requestedHistory.current.delete(appSessionId);
      return;
    }
    if (restore?.status === 'loading' || requestedHistory.current.has(appSessionId)) return;
    requestedHistory.current.add(appSessionId);
    dispatch({ type: 'SESSION_RESTORE_START', appSessionId });
    loadSessionHistory(appSessionId, undefined, transcriptRehydrationLimit(restore));
  }, [activeSession, embedded, state.historyLoaded, state.sessionRestore, dispatch]);

  useEffect(() => {
    if (embedded || !activeSession) return;
    const selection = state.selectedChild;
    if (!selection) return;
    if (selection.parentAppSessionId !== activeSession.appSessionId) return;
    const access = childAccessForSelection(
      state.childAccess,
      selection.parentAppSessionId,
      selection.childSessionId,
    );
    if (!shouldOpenSelectedChild(access)) return;
    const requestId = newChildOpenRequestId();
    dispatch({ type: 'SELECT_CHILD', selection, requestId });
    openChild(selection.parentAppSessionId, selection.childSessionId, requestId);
  }, [activeSession, embedded, state.selectedChild, state.childAccess, dispatch]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTerminalTabShortcut(e)) {
        if (isTerminalInputTarget(e.target)) return;
        e.preventDefault();
        if (e.repeat) return;
        openUtilityTool('terminal');
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'b' || key === 'f' || key === 'r') {
          e.preventDefault();
          openUtilityTool(key === 'b' ? 'browser' : key === 'f' ? 'files' : 'review');
          return;
        }
      }
      switch (e.key.toLowerCase()) {
        case 'k':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_COMMAND_PALETTE' });
          break;
        case 'b':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SIDEBAR' });
          break;
        case '\\':
          e.preventDefault();
          toggleUtilityPane();
          break;
        case ',':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SETTINGS' });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [dispatch, openUtilityTool, toggleUtilityPane]);

  const setupBlocker =
    !showWizard &&
    !embedded &&
    onboard.ready &&
    onboard.onboarding?.completed === true &&
    hasSetupBlocker(onboard.env);
  const showBanner = !bannerDismissed && setupBlocker;

  return (
    <div
      id="app-root"
      className="h-screen w-screen flex flex-col bg-droid-bg text-droid-text overflow-hidden relative"
    >
      {showBanner && (
        <SetupBanner
          kind="blocker"
          message="Finish setting up Droid to start running agents."
          actionLabel="Finish setup"
          onAction={() => {
            setForceWizard(true);
          }}
          onDismiss={() => {
            setBannerDismissed(true);
          }}
        />
      )}
      <RuntimeStatusBanner />
      <div className="flex-1 flex min-h-0 relative">
        {/* Sidebar with collapse animation */}
        <AnimatePresence initial={false}>
          {!state.sidebarCollapsed && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 280, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="shrink-0 overflow-hidden h-full"
            >
              <Sidebar
                workspaceScopes={workspaceScopes}
                onShowEarlierSessions={showEarlierSessions}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <main className="relative flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden bg-droid-bg">
          {state.sidebarCollapsed && <div data-electron-drag-region className="h-9 shrink-0" />}
          <div ref={contentRowRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <section
              aria-hidden={browserExpanded}
              className={`relative flex min-w-0 flex-1 flex-col overflow-hidden ${
                browserExpanded ? 'pointer-events-none' : ''
              }`}
            >
              {!embedded && state.mainView === 'pull-requests' ? (
                <Suspense fallback={<PullRequestsSkeleton />}>
                  <LazyPullRequestsView />
                </Suspense>
              ) : isMissionControlView ? (
                <motion.div
                  key="mission-control"
                  className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden"
                  initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0.4 }}
                  animate={{ clipPath: 'inset(0 0% 0 0)', opacity: 1 }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                >
                  <Suspense fallback={<MissionControlSkeleton />}>
                    <LazyMissionControl />
                  </Suspense>
                </motion.div>
              ) : (
                <>
                  <ChatView rightInset={rightPanelVisible} isObscured={browserExpanded} />
                  <PromptInput rightInset={rightPanelVisible} />
                </>
              )}
            </section>

            <AnimatePresence initial={false}>
              {showUtilityPane && (
                <motion.div
                  key="utility-pane"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{
                    width:
                      browserExpanded && contentRowWidth > 0 ? contentRowWidth : utilityPaneWidth,
                    opacity: 1,
                  }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full min-w-0 shrink-0 overflow-hidden"
                >
                  <UtilityPane
                    panel={utilityPanel}
                    expanded={browserExpanded}
                    width={utilityPaneWidth}
                    minWidth={UTILITY_PANE_MIN}
                    maxWidth={utilityPaneMax}
                    onResize={setUtilityPaneWidth}
                    onResizeEnd={(width) => {
                      const next = clampUtilityPane(width, contentRowWidth || undefined);
                      setUtilityPaneWidth(next);
                      try {
                        localStorage.setItem(UTILITY_PANE_WIDTH_STORAGE_KEY, String(next));
                      } catch {
                        /* ignore */
                      }
                    }}
                    onOpenTool={openUtilityTool}
                    onActivateTab={(tabId) => {
                      const nextTab = utilityPanel.tabs.find((tab) => tab.id === tabId);
                      if (nextTab?.tool !== 'browser') setExpandedBrowserAppSessionId(null);
                      dispatch({ type: 'ACTIVATE_UTILITY_TAB', tabId });
                    }}
                    onCloseTab={(tab) => {
                      if (
                        tab.tool === 'terminal' &&
                        !window.confirm('Close this terminal and stop its running process?')
                      ) {
                        return;
                      }
                      if (tab.tool === 'terminal') {
                        void closeTerminalForTab(tab.id, tab.terminalId).finally(() => {
                          dispatch({
                            type: 'CLOSE_UTILITY_TAB',
                            tabId: tab.id,
                            appSessionId: activeSession.appSessionId,
                          });
                        });
                        return;
                      }
                      if (tab.tool === 'browser') setExpandedBrowserAppSessionId(null);
                      dispatch({ type: 'CLOSE_UTILITY_TAB', tabId: tab.id });
                    }}
                    onClosePane={() => {
                      setExpandedBrowserAppSessionId(null);
                      dispatch({ type: 'SET_UTILITY_PANEL_OPEN', open: false });
                    }}
                    renderTab={(tab, { overlayOpen }) => {
                      if (tab.tool === 'review') {
                        return (
                          <Suspense fallback={utilityToolFallback('review')}>
                            <LazyReviewPanel cwd={workingDirectory} />
                          </Suspense>
                        );
                      }
                      if (tab.tool === 'browser') {
                        return (
                          <Suspense fallback={utilityToolFallback('browser')}>
                            <LazyBrowserFocusWorkspace
                              expanded={browserExpanded}
                              externalObscured={overlayOpen}
                              onToggleExpanded={() => {
                                setExpandedBrowserAppSessionId(
                                  browserExpanded ? null : activeSession.appSessionId,
                                );
                              }}
                            />
                          </Suspense>
                        );
                      }
                      if (tab.tool === 'terminal') {
                        return (
                          <Suspense fallback={utilityToolFallback('terminal')}>
                            <LazyTerminalWorkspace
                              tabId={tab.id}
                              terminalId={tab.terminalId}
                              appSessionId={activeSession.appSessionId}
                              cwd={tab.cwd ?? workingDirectory}
                              onCreated={(terminalId, label) => {
                                dispatch({
                                  type: 'UPDATE_UTILITY_TAB',
                                  tabId: tab.id,
                                  appSessionId: activeSession.appSessionId,
                                  terminalId,
                                  label,
                                });
                              }}
                            />
                          </Suspense>
                        );
                      }
                      return (
                        <Suspense fallback={utilityToolFallback('files')}>
                          <LazyFilesWorkspace
                            root={workingDirectory}
                            selectedPath={tab.filePath}
                            onSelectPath={(filePath) => {
                              dispatch({
                                type: 'UPDATE_UTILITY_TAB',
                                tabId: tab.id,
                                appSessionId: activeSession.appSessionId,
                                filePath,
                              });
                            }}
                          />
                        </Suspense>
                      );
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        {/* Floating overlay — does not take flex space, so `main` keeps full
            width and its scrollbar stays at the window's right edge. */}
        <AnimatePresence initial={false}>
          {rightPanelVisible && (
            <motion.div
              key="right-panel"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="absolute top-0 right-0 h-full w-[312px] z-30"
            >
              <RightPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating window controls — rendered LAST so their `no-drag` regions are
          accumulated after the full-width header drag regions (sidebar/chat/
          session headers). Earlier in the DOM, those overlapping drag regions
          would re-assert `drag` over these buttons and swallow their clicks
          (Electron #27149). They stay absolutely positioned, so paint order and
          layout are unchanged. */}
      <div
        data-electron-drag-region
        className="absolute top-0 left-[92px] h-9 z-40 flex items-center gap-1.5"
      >
        <button
          onClick={() => {
            dispatch({ type: 'TOGGLE_SIDEBAR' });
          }}
          className="p-1.5 rounded-md text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
          title="Toggle sidebar (Cmd+B)"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
      </div>

      {!showUtilityPane && !prWorkspaceView && (
        <div
          data-electron-drag-region
          className="absolute top-0 right-0 h-9 z-40 flex items-center gap-1 pr-3"
        >
          {workingDirectory && (
            <EditorOpenMenu cwd={workingDirectory} hasRepo={!!repoStatus} variant="toolbar" />
          )}
          {canToggleContext && (
            <button
              onClick={toggleRightPanel}
              className={`p-1.5 rounded-md transition-colors ${
                state.rightPanelOpen
                  ? 'text-droid-text bg-droid-elevated'
                  : 'text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60'
              }`}
              title="Toggle context"
            >
              <ContextListIcon className="w-4 h-4" />
            </button>
          )}
          {!!activeSession && (
            <button
              ref={utilityPaneToggleRef}
              onClick={toggleUtilityPane}
              className="rounded-md p-1.5 text-droid-text-muted/70 transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
              title="Toggle utility pane (Cmd+\\)"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {state.commandPaletteOpen && (
        <Suspense fallback={<CommandPaletteSkeleton />}>
          <LazyCommandPalette />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <LazySpecWikiModal />
      </Suspense>
      <Toaster />

      <AnimatePresence>{state.settingsOpen && <SettingsLazyHost />}</AnimatePresence>

      <AnimatePresence>
        {showWizard && onboard.ready && (
          <OnboardingLazyHost
            controller={onboard}
            onComplete={() => {
              setForceWizard(false);
              setBannerDismissed(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function initialUtilityPaneWidth(): number {
  if (typeof window === 'undefined') return UTILITY_PANE_DEFAULT;
  try {
    const stored = Number(
      localStorage.getItem(UTILITY_PANE_WIDTH_STORAGE_KEY) ??
        localStorage.getItem('droid-browser-pane-width'),
    );
    if (Number.isFinite(stored) && stored > 0) return clampUtilityPane(stored);
  } catch {
    /* ignore */
  }
  return clampUtilityPane(Math.min(UTILITY_PANE_DEFAULT, Math.round(window.innerWidth * 0.42)));
}

function utilityPaneMaxWidth(availableWidth?: number): number {
  if (typeof window === 'undefined') return UTILITY_PANE_MAX;
  const available = availableWidth ?? window.innerWidth;
  return Math.max(
    UTILITY_PANE_MIN,
    Math.min(UTILITY_PANE_MAX, Math.round(available - UTILITY_PANE_CONTENT_RESERVE)),
  );
}

function clampUtilityPane(width: number, availableWidth?: number): number {
  return Math.min(
    utilityPaneMaxWidth(availableWidth),
    Math.max(UTILITY_PANE_MIN, Math.round(width)),
  );
}

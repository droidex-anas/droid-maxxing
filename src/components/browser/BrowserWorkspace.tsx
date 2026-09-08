import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDesignModeOpen } from '../../hooks/designModeState';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { useSessionLive, useSessionWorkActive } from '../../hooks/useSessionLive';
import { openBrowser, reloadBrowser, resizeBrowserViewport } from '../../lib/commands';
import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import {
  CUSTOM_DEFAULT_VIEWPORT,
  normalizeBrowserOmniboxInput,
  sameViewport,
  viewportForMode,
  viewportFromFrame,
} from './browserViewport';
import { NativeBrowserSurface } from './NativeBrowserSurface';
import { isDesktop } from '../../lib/desktop';
import {
  goBackNativeBrowser,
  goForwardNativeBrowser,
  type NativeBrowserLoadFailed,
} from '../../lib/nativeBrowser';
import { BrowserLoadFailureBanner } from './BrowserLoadFailureBanner';
import { BrowserToolbar } from './BrowserToolbar';
import { DesignModeComposer } from './DesignModeComposer';
import { composerStyleForReferences } from './browserComposerPosition';
import { browserKeyForSession } from '../../lib/browserSessionIdentity';
import { browserAddressValue, isSelfBrowserUrl, safeBrowserUrl } from './browserUrlSafety';
import { shouldResetBrowserLoading } from './browserLoading';
import { useElementSize } from './useElementSize';
import { useBrowserAutoReload } from './useBrowserAutoReload';
import { useBrowserDesignPrompt } from './useBrowserDesignPrompt';

export default function BrowserWorkspace({
  expanded = false,
  externalObscured = false,
  onToggleExpanded,
}: {
  expanded?: boolean;
  externalObscured?: boolean;
  onToggleExpanded?: () => void;
}) {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      activeSession: current.activeAppSessionId
        ? current.sessions[current.activeAppSessionId]
        : undefined,
      browserErrors: current.browserErrors,
      browserGlobalError: current.browserGlobalError,
      browsers: current.browsers,
      commandPaletteOpen: current.commandPaletteOpen,
      designModes: current.designModes,
      pendingQuestions: current.pendingQuestions,
      pendingPermissions: current.pendingPermissions,
      settingsOpen: current.settingsOpen,
    }),
    shallowEqual,
  );
  const requestedChatId = state.activeAppSessionId ?? undefined;
  const activeSession = state.activeSession;
  const browserKey = browserKeyForSession(activeSession);
  const browser = browserKey ? state.browsers[browserKey] : undefined;
  const browserError = browserKey ? state.browserErrors[browserKey] : state.browserGlobalError;
  const designMode = isDesignModeOpen(state.designModes, browserKey);
  const sessionLive = useSessionLive(requestedChatId ?? null);
  const sessionWorkActive = useSessionWorkActive(requestedChatId ?? null);
  const nativeBrowser = isDesktop();
  // The native BrowserView is an OS-level layer painted above the React tree,
  // so any full-screen overlay would otherwise be punched through by it. Detach
  // it while such an overlay is visible and re-attach once it closes.
  const pendingQuestion = requestedChatId ? state.pendingQuestions[requestedChatId] : undefined;
  const pendingPermission = requestedChatId ? state.pendingPermissions[requestedChatId] : undefined;
  const obscured =
    externalObscured ||
    state.settingsOpen ||
    state.commandPaletteOpen ||
    !!pendingQuestion ||
    pendingPermission?.kind === 'spec';
  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const appOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  const frameSize = useElementSize(frameRef);
  const frameReady = frameSize.width > 8 && frameSize.height > 8;
  const fitViewport = useMemo(() => viewportFromFrame(frameSize, expanded), [expanded, frameSize]);
  const initialUrl = safeBrowserUrl(browser?.url, appOrigin);
  const [urlInput, setUrlInput] = useState(browserAddressValue(initialUrl));
  const [activeUrl, setActiveUrl] = useState(initialUrl);
  const [viewportMode, setViewportMode] = useState<BrowserViewportMode>(
    browser?.viewportMode ?? 'fit',
  );
  const [customViewport, setCustomViewport] = useState<BrowserViewport>(CUSTOM_DEFAULT_VIEWPORT);
  const [actualViewport, setActualViewport] = useState<Size>({ width: 1, height: 1 });
  const [loadFailure, setLoadFailure] = useState<NativeBrowserLoadFailed | null>(null);
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(browser?.canGoBack ?? false);
  const [canGoForward, setCanGoForward] = useState(browser?.canGoForward ?? false);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browserIdentityRef = useRef({
    browserKey,
    browserSessionId: browser?.browserSessionId,
  });
  const {
    canSend,
    disabledReason,
    handleNativePrompt,
    handleSelection,
    instruction,
    pencilMode,
    references,
    sendPrompt,
    setInstruction,
    setPencilMode,
    setReferences,
  } = useBrowserDesignPrompt({
    browserKey,
    browserSessionId: browser?.browserSessionId,
    browserUrl: browser?.url,
    designMode,
    requestedChatId,
    sessionLive,
  });
  const startLoading = useCallback(() => {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    setLoading(true);
    loadingTimerRef.current = setTimeout(() => {
      loadingTimerRef.current = null;
      setLoading(false);
    }, 10_000);
  }, []);
  const stopLoading = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    setLoading(false);
  }, []);

  useEffect(
    () => () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    },
    [],
  );

  useBrowserAutoReload(browserKey, activeUrl, requestedChatId);

  useEffect(() => {
    if (!browser?.url) return;
    const nextUrl = safeBrowserUrl(browser.url, appOrigin);
    if (document.activeElement !== urlInputRef.current) {
      setUrlInput(browserAddressValue(nextUrl));
    }
    if (nextUrl !== activeUrl) {
      setActiveUrl(nextUrl);
    }
  }, [activeUrl, appOrigin, browser?.url]);

  useEffect(() => {
    if (browser?.viewportMode) setViewportMode(browser.viewportMode);
  }, [browser?.viewportMode]);

  useEffect(() => {
    if (typeof browser?.canGoBack === 'boolean') setCanGoBack(browser.canGoBack);
    if (typeof browser?.canGoForward === 'boolean') setCanGoForward(browser.canGoForward);
  }, [browser?.canGoBack, browser?.canGoForward]);

  useEffect(() => {
    const browserIdentity = { browserKey, browserSessionId: browser?.browserSessionId };
    const previousIdentity = browserIdentityRef.current;
    if (
      previousIdentity.browserKey === browserIdentity.browserKey &&
      previousIdentity.browserSessionId === browserIdentity.browserSessionId
    )
      return;
    browserIdentityRef.current = browserIdentity;
    if (shouldResetBrowserLoading(previousIdentity, browserIdentity)) {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setLoading(false);
    }
    setCanGoBack(browser?.canGoBack ?? false);
    setCanGoForward(browser?.canGoForward ?? false);
    const nextUrl = safeBrowserUrl(browser?.url, appOrigin);
    setActiveUrl(nextUrl);
    if (document.activeElement !== urlInputRef.current) {
      setUrlInput(browserAddressValue(nextUrl));
    }
  }, [
    appOrigin,
    browser?.canGoBack,
    browser?.canGoForward,
    browser?.browserSessionId,
    browser?.url,
    browserKey,
  ]);

  useEffect(() => {
    if (browser?.viewport && browser.viewportMode === 'custom') {
      setCustomViewport(browser.viewport);
    }
  }, [browser?.viewport, browser?.viewportMode]);

  useEffect(() => {
    setLoadFailure(null);
  }, [browser?.browserSessionId, browser?.url, browserKey]);

  const requestedViewport = viewportForMode(viewportMode, fitViewport, customViewport);
  const composerStyle = useMemo(
    () => composerStyleForReferences(references, frameSize, requestedViewport, viewportMode),
    [frameSize, references, requestedViewport, viewportMode],
  );

  useEffect(() => {
    if (!browserKey || !browser) return;
    if (browser.viewportMode === viewportMode && sameViewport(browser.viewport, requestedViewport))
      return;
    const id = window.setTimeout(() => {
      resizeBrowserViewport({
        appSessionId: browserKey,
        viewport: requestedViewport,
        viewportMode,
      });
    }, 120);
    return () => {
      window.clearTimeout(id);
    };
  }, [
    browser?.viewport.deviceScaleFactor,
    browser?.viewport.height,
    browser?.viewport.width,
    browser?.viewportMode,
    requestedViewport.deviceScaleFactor,
    requestedViewport.height,
    requestedViewport.width,
    browserKey,
    viewportMode,
  ]);

  const openCurrentUrl = () => {
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeBrowserOmniboxInput(urlInput);
    } catch (error) {
      dispatch({
        type: 'BROWSER_ERROR',
        appSessionId: browserKey,
        message:
          error instanceof Error ? error.message : 'Enter a website address or search terms.',
      });
      return;
    }
    if (browserKey && isSelfBrowserUrl(normalizedUrl, appOrigin)) {
      setUrlInput(normalizedUrl);
      dispatch({
        type: 'BROWSER_ERROR',
        appSessionId: browserKey,
        message:
          'Cannot open the Droid Control shell inside its own browser pane. Use a different local app port.',
      });
      return;
    }
    const url = safeBrowserUrl(normalizedUrl, appOrigin);
    setLoadFailure(null);
    startLoading();
    setUrlInput(browserAddressValue(url));
    setActiveUrl(url);
    if (browserKey) {
      openBrowser({
        appSessionId: browserKey,
        url,
        viewport: requestedViewport,
        viewportMode,
      });
    }
  };

  const navigateHistory = useCallback(
    async (direction: 'back' | 'forward') => {
      if (!browser?.browserSessionId) return;
      setLoadFailure(null);
      startLoading();
      try {
        const moved =
          direction === 'back'
            ? await goBackNativeBrowser(browser.browserSessionId)
            : await goForwardNativeBrowser(browser.browserSessionId);
        if (!moved) stopLoading();
      } catch (error) {
        stopLoading();
        setLoadFailure({
          browserSessionId: browser.browserSessionId,
          url: activeUrl,
          error: error instanceof Error ? error.message : `Could not go ${direction}.`,
        });
      }
    },
    [activeUrl, browser?.browserSessionId, startLoading, stopLoading],
  );

  const handleLoadFailed = useCallback((failure: NativeBrowserLoadFailed) => {
    setLoadFailure(failure);
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-droid-bg">
      <BrowserToolbar
        urlInputRef={urlInputRef}
        urlInput={urlInput}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        loading={loading}
        designMode={designMode}
        designModeDisabled={!browserKey}
        pencilMode={pencilMode}
        expanded={expanded}
        onUrlInputChange={setUrlInput}
        onOpen={openCurrentUrl}
        onGoBack={() => void navigateHistory('back')}
        onGoForward={() => void navigateHistory('forward')}
        onReload={() => {
          startLoading();
          if (browserKey && browser) reloadBrowser(browserKey);
          else openCurrentUrl();
        }}
        onToggleDesignMode={() => {
          if (browserKey) dispatch({ type: 'TOGGLE_DESIGN_MODE', appSessionId: browserKey });
        }}
        onTogglePencilMode={() => {
          setPencilMode((value) => !value);
        }}
        onToggleExpanded={onToggleExpanded}
      />

      {browserError && (
        <div className="shrink-0 border-b border-droid-border bg-droid-accent/10 px-4 py-2 text-[12px] text-droid-text-secondary">
          {browserError}
        </div>
      )}

      {loadFailure && (
        <BrowserLoadFailureBanner
          failure={loadFailure}
          onRetry={() => {
            setLoadFailure(null);
            startLoading();
            if (browserKey && browser) reloadBrowser(browserKey);
            else openCurrentUrl();
          }}
          onDismiss={() => {
            setLoadFailure(null);
          }}
        />
      )}

      <div ref={frameRef} className="relative flex-1 min-h-0 min-w-0">
        {browserKey && frameReady ? (
          <NativeBrowserSurface
            isAgentRunning={sessionWorkActive}
            browserKey={browserKey}
            visibleBrowserSessionId={browser?.browserSessionId}
            obscured={obscured}
            url={activeUrl}
            viewport={requestedViewport}
            viewportMode={viewportMode}
            designMode={designMode}
            pencilMode={designMode && pencilMode}
            frameSize={frameSize}
            onLoaded={(event) => {
              setLoadFailure(null);
              stopLoading();
              setCanGoBack(event.canGoBack ?? canGoBack);
              setCanGoForward(event.canGoForward ?? canGoForward);
              const nextUrl = safeBrowserUrl(event.url, appOrigin);
              setActiveUrl(nextUrl);
              if (document.activeElement !== urlInputRef.current)
                setUrlInput(browserAddressValue(nextUrl));
              if (browserKey && event.browserSessionId) {
                dispatch({
                  type: 'BROWSER_NAVIGATED',
                  appSessionId: browserKey,
                  browserSessionId: event.browserSessionId,
                  url: event.url,
                  canGoBack: event.canGoBack,
                  canGoForward: event.canGoForward,
                });
              }
            }}
            onSelection={handleSelection}
            onPrompt={handleNativePrompt}
            onLoadFailed={(failure) => {
              stopLoading();
              handleLoadFailed(failure);
            }}
            onViewportSizeChange={setActualViewport}
            expanded={expanded}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#070707] px-6 text-sm text-droid-text-muted">
            {browserKey ? 'Preparing browser pane...' : 'Select or create a Droid session.'}
          </div>
        )}

        {browserKey && !browser && frameReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#070707] px-6 text-sm text-droid-text-muted">
            Open a URL to start this chat&apos;s browser.
          </div>
        )}

        {!nativeBrowser && designMode && references.length > 0 && (
          <DesignModeComposer
            references={references}
            instruction={instruction}
            canSend={canSend}
            disabledReason={disabledReason}
            style={composerStyle}
            onInstructionChange={setInstruction}
            onRemoveReference={(id) => {
              setReferences((prev) => prev.filter((item) => item.id !== id));
            }}
            onSend={sendPrompt}
          />
        )}

        <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-droid-border bg-droid-bg/90 px-2.5 py-1.5 text-[11px] text-droid-text-muted shadow-lg">
          <span className="font-mono text-droid-text-secondary">
            {actualViewport.width}x{actualViewport.height}
          </span>
          <span>{viewportMode}</span>
        </div>
      </div>
    </div>
  );
}

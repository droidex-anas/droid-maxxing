import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { isDesktop } from '../../lib/desktop';
import { attachIframeDesignMode } from '../../lib/iframeDesignMode';
import {
  attachNativeBrowser,
  detachNativeBrowser,
  onNativeBrowserDesignPrompt,
  onNativeBrowserLoadFailed,
  onNativeBrowserLoaded,
  onNativeBrowserSelection,
  setNativeBrowserBounds,
  setNativeBrowserDesignMode,
  setNativeBrowserPencilMode,
  setNativeBrowserVisible,
  type NativeBrowserBounds,
  type NativeBrowserDesignPrompt,
  type NativeBrowserLoadFailed,
  type NativeBrowserLoaded,
  type NativeBrowserSelection,
} from '../../lib/nativeBrowser';
import { registerNativeBrowserController } from '../../lib/nativeBrowserAgent';
import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import { browserSurfaceLayout } from './browserViewport';
import { performIframeRequest, readIframeUrl } from './nativeBrowserIframeFallback';
import { createNativeBrowserAttacher, retryNativeBrowserAttach } from './nativeBrowserAttachment';

interface NativeBrowserSurfaceProps {
  browserKey: string;
  visibleBrowserSessionId?: string;
  // Incremented by the workspace's retry control to re-run the attach effect
  // after an attach failure left the native view unmounted.
  attachAttempt?: number;
  obscured?: boolean;
  isAgentRunning: boolean;
  url: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  designMode: boolean;
  pencilMode: boolean;
  expanded?: boolean;
  frameSize: Size;
  onLoaded: (event: NativeBrowserLoaded) => void;
  onSelection: (selection: NativeBrowserSelection) => void;
  onPrompt: (prompt: NativeBrowserDesignPrompt) => void;
  onLoadFailed?: (failure: NativeBrowserLoadFailed) => void;
  onViewportSizeChange: (size: Size) => void;
}

export function NativeBrowserSurface({
  browserKey,
  visibleBrowserSessionId,
  attachAttempt = 0,
  obscured = false,
  isAgentRunning,
  url,
  viewport,
  viewportMode,
  designMode,
  pencilMode,
  expanded = false,
  frameSize,
  onLoaded,
  onSelection,
  onPrompt,
  onLoadFailed,
  onViewportSizeChange,
}: NativeBrowserSurfaceProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const surfaceReady = frameSize.width > 8 && frameSize.height > 8;
  const lastBounds = useRef<NativeBrowserBounds | null>(null);
  const pendingBounds = useRef<{
    browserSessionId: string;
    bounds: NativeBrowserBounds;
  } | null>(null);
  const boundsFrame = useRef(0);
  const attachedSessionRef = useRef<string | undefined>(undefined);
  const attachingSessionRef = useRef<string | undefined>(undefined);
  const onLoadedRef = useRef(onLoaded);
  const onSelectionRef = useRef(onSelection);
  const onPromptRef = useRef(onPrompt);
  const onLoadFailedRef = useRef(onLoadFailed);
  const presentationRef = useRef({ obscured, isAgentRunning });
  const urlRef = useRef(url);
  urlRef.current = url;
  const native = isDesktop();
  const attachBrowser = useMemo(() => createNativeBrowserAttacher(attachNativeBrowser), []);
  const surface = useMemo(
    () => surfaceLayout(frameSize, viewport, viewportMode, expanded),
    [expanded, frameSize, viewport, viewportMode],
  );
  const scheduleBoundsUpdate = useCallback(
    (browserSessionId: string, bounds: NativeBrowserBounds) => {
      pendingBounds.current = { browserSessionId, bounds };
      if (boundsFrame.current) return;
      boundsFrame.current = requestAnimationFrame(() => {
        boundsFrame.current = 0;
        const pending = pendingBounds.current;
        pendingBounds.current = null;
        if (!pending) return;
        lastBounds.current = pending.bounds;
        setNativeBrowserBounds(pending.browserSessionId, pending.bounds).catch(() => undefined);
      });
    },
    [],
  );

  useEffect(
    () => () => {
      if (boundsFrame.current) cancelAnimationFrame(boundsFrame.current);
    },
    [],
  );

  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onSelectionRef.current = onSelection;
    onPromptRef.current = onPrompt;
    onLoadFailedRef.current = onLoadFailed;
    presentationRef.current = { obscured, isAgentRunning };
  }, [obscured, isAgentRunning, onLoadFailed, onLoaded, onPrompt, onSelection]);

  useEffect(() => {
    onViewportSizeChange({ width: Math.round(surface.width), height: Math.round(surface.height) });
  }, [onViewportSizeChange, surface.height, surface.width]);

  useEffect(() => {
    if (!visibleBrowserSessionId) return;
    const designActive = !obscured && designMode;
    Promise.all([
      setNativeBrowserDesignMode(visibleBrowserSessionId, designActive),
      setNativeBrowserPencilMode(visibleBrowserSessionId, designActive && pencilMode),
    ]).catch(() => undefined);
  }, [designMode, obscured, pencilMode, visibleBrowserSessionId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const matchesVisibleSession = (browserSessionId?: string) =>
      !browserSessionId || browserSessionId === visibleBrowserSessionId;
    const track = (promise: Promise<() => void>) => {
      void promise.then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      });
    };

    track(
      onNativeBrowserSelection((selection) => {
        if (!matchesVisibleSession(selection.browserSessionId)) return;
        onSelectionRef.current(selection);
      }),
    );
    track(
      onNativeBrowserDesignPrompt((prompt) => {
        if (!matchesVisibleSession(prompt.selection.browserSessionId)) return;
        onPromptRef.current(prompt);
      }),
    );
    track(
      onNativeBrowserLoaded((event) => {
        if (!matchesVisibleSession(event.browserSessionId)) return;
        onLoadedRef.current(event);
      }),
    );
    track(
      onNativeBrowserLoadFailed((failure) => {
        if (!matchesVisibleSession(failure.browserSessionId)) return;
        onLoadFailedRef.current?.(failure);
      }),
    );

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [visibleBrowserSessionId]);

  useEffect(() => {
    if (native) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let detachDesignMode: () => void = () => undefined;
    const attach = () => {
      detachDesignMode();
      try {
        detachDesignMode = attachIframeDesignMode(iframe, {
          designMode,
          pencilMode,
          onSelection: (selection) => {
            onSelectionRef.current(selection);
          },
        });
        onLoadedRef.current({
          browserSessionId: visibleBrowserSessionId ?? browserKey,
          url: readIframeUrl(iframe) ?? url,
        });
      } catch {
        // Cross-origin pages still render but cannot expose iframe design controls.
        detachDesignMode = () => undefined;
      }
    };
    attach();
    iframe.addEventListener('load', attach);
    return () => {
      iframe.removeEventListener('load', attach);
      detachDesignMode();
    };
  }, [browserKey, designMode, native, pencilMode, url, visibleBrowserSessionId]);

  useLayoutEffect(() => {
    if (!native) return;
    if (!visibleBrowserSessionId) return;
    setNativeBrowserVisible(visibleBrowserSessionId, !obscured, isAgentRunning).catch(
      () => undefined,
    );
  }, [native, obscured, isAgentRunning, visibleBrowserSessionId]);

  useEffect(() => {
    if (!native) return;
    if (obscured) return;
    if (!surfaceReady) return;
    const bounds = boundsFor(slotRef);
    if (!bounds) return;
    if (!visibleBrowserSessionId) {
      pendingBounds.current = null;
      detachNativeBrowser().catch(() => undefined);
      attachedSessionRef.current = undefined;
      attachingSessionRef.current = undefined;
      lastBounds.current = null;
      return;
    }
    if (attachedSessionRef.current !== visibleBrowserSessionId) {
      const target = visibleBrowserSessionId;
      attachingSessionRef.current = target;
      const cancelAttach = retryNativeBrowserAttach({
        attach: () => attachBrowser(target, bounds, urlRef.current),
        onAttached: () => {
          if (attachingSessionRef.current !== target) return;
          attachedSessionRef.current = target;
          attachingSessionRef.current = undefined;
          lastBounds.current = bounds;
          const latestBounds = boundsFor(slotRef);
          if (latestBounds && !equalBounds(bounds, latestBounds)) {
            scheduleBoundsUpdate(target, latestBounds);
          }
          if (presentationRef.current.obscured) {
            setNativeBrowserVisible(target, false, presentationRef.current.isAgentRunning).catch(
              () => undefined,
            );
          }
        },
        onFailed: (error) => {
          if (attachingSessionRef.current !== target) return;
          attachingSessionRef.current = undefined;
          onLoadFailedRef.current?.({
            browserSessionId: target,
            url: urlRef.current,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      return () => {
        cancelAttach();
        if (attachingSessionRef.current === target) attachingSessionRef.current = undefined;
      };
    }
  }, [
    attachAttempt,
    attachBrowser,
    native,
    obscured,
    surfaceReady,
    scheduleBoundsUpdate,
    visibleBrowserSessionId,
  ]);

  useEffect(() => {
    if (!native || obscured || !visibleBrowserSessionId) return;
    if (attachedSessionRef.current !== visibleBrowserSessionId) return;
    const bounds = boundsFor(slotRef);
    if (bounds && (!lastBounds.current || !equalBounds(lastBounds.current, bounds))) {
      scheduleBoundsUpdate(visibleBrowserSessionId, bounds);
    }
  }, [
    native,
    obscured,
    surface.height,
    surface.left,
    surface.top,
    surface.width,
    surfaceReady,
    scheduleBoundsUpdate,
    visibleBrowserSessionId,
  ]);

  useEffect(() => {
    if (native) return;
    return registerNativeBrowserController({
      appSessionId: browserKey,
      browserSessionId: visibleBrowserSessionId,
      perform: (request) =>
        performIframeRequest(request, {
          currentUrl: urlRef.current,
          iframe: iframeRef,
          onLoaded: (url) => {
            onLoadedRef.current({ browserSessionId: request.browserSessionId, url });
          },
        }),
    });
  }, [browserKey, native, visibleBrowserSessionId]);

  useEffect(() => {
    return () => {
      if (native) detachNativeBrowser(visibleBrowserSessionId).catch(() => undefined);
    };
  }, [native, visibleBrowserSessionId]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-[#070707]">
      <div
        ref={slotRef}
        className={`absolute overflow-hidden bg-white ${
          expanded
            ? 'rounded-none'
            : 'rounded-[6px] shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_24px_80px_rgba(0,0,0,0.45)]'
        }`}
        style={{
          left: surface.left,
          top: surface.top,
          width: surface.width,
          height: surface.height,
        }}
      >
        {!native && (
          <iframe
            ref={iframeRef}
            src={url}
            title="DROIDEX Browser"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          />
        )}
      </div>
    </div>
  );
}

function surfaceLayout(
  frame: Size,
  viewport: BrowserViewport,
  mode: BrowserViewportMode,
  expanded = false,
) {
  if (expanded && mode === 'fit') {
    return {
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
      left: 0,
      top: 0,
    };
  }
  return browserSurfaceLayout(frame, viewport, mode);
}

function boundsFor(ref: RefObject<HTMLElement | null>): NativeBrowserBounds | null {
  const node = ref.current;
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function equalBounds(a: NativeBrowserBounds, b: NativeBrowserBounds): boolean {
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

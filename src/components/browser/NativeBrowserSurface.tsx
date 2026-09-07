import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { isDesktop } from '../../lib/desktop';
import {
  attachIframeDesignMode,
  clickIframe,
  hoverIframe,
  keypressIframe,
  scrollIframe,
  selectOptionIframe,
  snapshotIframe,
  typeIntoIframe,
} from '../../lib/iframeDesignMode';
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
import type {
  BrowserNativeRequest,
  BrowserNativeResult,
  BrowserViewport,
  BrowserViewportMode,
} from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import { createNativeBrowserAttacher, retryNativeBrowserAttach } from './nativeBrowserAttachment';

interface NativeBrowserSurfaceProps {
  browserKey: string;
  visibleBrowserSessionId?: string;
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

function readIframeUrl(iframe: HTMLIFrameElement): string | undefined {
  try {
    return iframe.contentWindow?.location.href;
  } catch {
    return undefined;
  }
}

async function performIframeRequest(
  request: BrowserNativeRequest,
  options: {
    currentUrl: string;
    iframe: RefObject<HTMLIFrameElement | null>;
    onLoaded: (url: string) => void;
  },
): Promise<BrowserNativeResult> {
  try {
    const iframe = options.iframe.current;
    if (!iframe) throw new Error('DROIDEX Browser pane is not mounted yet.');
    if (request.action === 'close') {
      iframe.src = 'about:blank';
      options.onLoaded('about:blank');
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
      };
    }
    if (request.action === 'open') {
      const targetUrl = request.url ?? options.currentUrl;
      await loadIframe(iframe, targetUrl);
      options.onLoaded(readIframeUrl(iframe) ?? targetUrl);
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
        snapshot: safeIframeSnapshot(iframe, targetUrl),
      };
    }
    if (request.action === 'reload') {
      await loadIframe(iframe, readIframeUrl(iframe) ?? options.currentUrl);
      options.onLoaded(readIframeUrl(iframe) ?? options.currentUrl);
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
        snapshot: safeIframeSnapshot(iframe, options.currentUrl),
      };
    }
    if (request.action === 'click') {
      await clickIframe(iframe, Number(request.x), Number(request.y));
    } else if (request.action === 'hover') {
      await hoverIframe(iframe, Number(request.x), Number(request.y), request.selector);
    } else if (request.action === 'selectOption') {
      if (!request.selector) throw new Error('A selector is required to select an option.');
      await selectOptionIframe(iframe, request.selector, request.text ?? '');
    } else if (request.action === 'type') {
      await typeIntoIframe(iframe, request.text ?? '');
    } else if (request.action === 'keypress') {
      await keypressIframe(iframe, request.key ?? '');
    } else if (request.action === 'scroll') {
      await scrollIframe(iframe, request.direction ?? 'down', request.pixels);
    } else if (request.action === 'capture') {
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
      };
    } else if (request.action !== 'snapshot') {
      throw new Error(`Unsupported browser action: ${request.action}`);
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
      snapshot: safeIframeSnapshot(iframe, options.currentUrl),
    };
  } catch (err) {
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function loadIframe(iframe: HTMLIFrameElement, url: string): Promise<void> {
  return new Promise((resolve) => {
    const targetUrl = absolutizeUrl(url);
    const startedAt = Date.now();
    iframe.src = url;
    const poll = () => {
      if (!iframe.isConnected) {
        resolve();
        return;
      }
      const currentUrl = readIframeUrl(iframe);
      if (currentUrl && currentUrl === targetUrl) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 5_000) {
        resolve();
        return;
      }
      window.setTimeout(poll, 50);
    };
    poll();
  });
}

function absolutizeUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

function safeIframeSnapshot(iframe: HTMLIFrameElement, fallbackUrl: string) {
  try {
    return snapshotIframe(iframe, fallbackUrl);
  } catch {
    return { url: readIframeUrl(iframe) ?? fallbackUrl, scroll: { x: 0, y: 0 }, refs: [] };
  }
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
  const padding = 18;
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const width = mode === 'fit' ? availableWidth : Math.min(viewport.width, availableWidth);
  const height = mode === 'fit' ? availableHeight : Math.min(viewport.height, availableHeight);
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
  };
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

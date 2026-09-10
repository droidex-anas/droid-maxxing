import type { RefObject } from 'react';
import {
  clickIframe,
  hoverIframe,
  keypressIframe,
  scrollIframe,
  selectOptionIframe,
  snapshotIframe,
  typeIntoIframe,
} from '../../lib/iframeDesignMode';
import type { BrowserNativeRequest, BrowserNativeResult } from '../../types/bridge';

export function readIframeUrl(iframe: HTMLIFrameElement): string | undefined {
  try {
    return iframe.contentWindow?.location.href;
  } catch {
    return undefined;
  }
}

export async function performIframeRequest(
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
      throw new Error('Screenshots are not available in the browser-only fallback.');
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

// Wait for the frame's own navigation: a reload (and an open to the URL already
// loaded) targets the URL the frame already reports, so comparing URLs resolves
// before the new document commits and the snapshot comes from the old one.
function loadIframe(iframe: HTMLIFrameElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => {
      finish();
    };
    const onError = () => {
      finish(new Error('Browser frame navigation failed.'));
    };
    const timer = window.setTimeout(() => {
      finish(new Error('Browser frame navigation timed out.'));
    }, 5_000);
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError);
    if (!iframe.isConnected) {
      finish(new Error('Browser frame was disconnected before navigation.'));
      return;
    }
    iframe.src = url;
  });
}

function safeIframeSnapshot(iframe: HTMLIFrameElement, fallbackUrl: string) {
  try {
    return snapshotIframe(iframe, fallbackUrl);
  } catch {
    return { url: readIframeUrl(iframe) ?? fallbackUrl, scroll: { x: 0, y: 0 }, refs: [] };
  }
}

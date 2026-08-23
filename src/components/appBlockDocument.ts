// The document that runs inside an App frame: the sandboxed HTML shell, its
// content policy, the host-facing style reset, and the bootstrap script that
// speaks the bridge protocol. The host side of that protocol lives in
// appBlockRuntime.
import { DEFAULT_APP_THEME, MAX_APP_ERROR_CHARS, type AppBlockTheme } from './appBlockRuntime';

export function createAppDocument(
  source: string,
  instanceId: string,
  theme: AppBlockTheme = DEFAULT_APP_THEME,
  bridgeToken = instanceId,
): string {
  const serializedId = JSON.stringify(instanceId).replaceAll('<', '\\u003c');
  const serializedBridgeToken = JSON.stringify(bridgeToken).replaceAll('<', '\\u003c');
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<style>
:root {
  color-scheme: ${theme.colorScheme};
  --app-background: ${theme.background};
  --app-surface: ${theme.surface};
  --app-foreground: ${theme.foreground};
  --app-muted: ${theme.muted};
  --app-border: ${theme.border};
  --app-accent: ${theme.accent};
  font-family: ui-sans-serif, system-ui, sans-serif;
}
html, body { margin: 0; min-width: 0; background: transparent; }
body { box-sizing: border-box; padding: 0; color: var(--app-foreground); overflow-wrap: anywhere; }
*, *::before, *::after { box-sizing: inherit; }
img, svg, canvas, video { display: block; max-width: 100%; height: auto; }
a { color: var(--app-accent); }
button, input, select, textarea {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-surface);
  color: var(--app-foreground);
  font: inherit;
}
::selection { background: color-mix(in srgb, var(--app-accent) 24%, transparent); }
</style>
<script>
(() => {
  const instanceId = ${serializedId};
  const bridgeToken = ${serializedBridgeToken};
  const pendingMath = new Map();
  let mathSequence = 0;
  let heightTimer = 0;
  let lastHeight = -1;
  let lastError = '';
  let initialRenderComplete = false;
  let disposed = false;
  const postError = (message) => {
    const reported = typeof message === 'string' ? message.trim() : '';
    const normalized = (reported || 'The interactive App failed to start.').slice(0, ${String(MAX_APP_ERROR_CHARS)});
    if (normalized === lastError) return;
    lastError = normalized;
    parent.postMessage({
      type: 'droidex:app-error',
      instanceId,
      bridgeToken,
      message: normalized,
    }, '*');
  };
  const onRuntimeError = (event) => {
    postError(event?.message || 'The interactive App failed to start.');
  };
  const onUnhandledRejection = (event) => {
    const reason = event?.reason;
    const message = reason && typeof reason === 'object' && 'message' in reason
      ? String(reason.message)
      : String(reason || '');
    postError(message);
  };
  addEventListener('error', onRuntimeError);
  addEventListener('unhandledrejection', onUnhandledRejection);
  // The host shows a started App at its first reported height, so that report
  // has to describe the finished layout: math is rendered by the host and lands
  // later, and nothing is worth reporting once the document is going away.
  // Reports coalesce on a timer, never an animation frame: the frame is hidden
  // until this first report arrives, and a hidden frame runs no animation
  // frames, so rAF would deadlock the report that reveals it.
  const reportHeight = () => {
    if (!initialRenderComplete || disposed || heightTimer) return;
    heightTimer = setTimeout(() => {
      heightTimer = 0;
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      if (height === lastHeight) return;
      lastHeight = height;
      parent.postMessage({ type: 'droidex:app-height', instanceId, bridgeToken, height }, '*');
    });
  };
  const renderMath = (target, latex, options = {}) => {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!(element instanceof Element) || typeof latex !== 'string') return Promise.resolve(false);
    const requestId = instanceId + '-math-' + String(++mathSequence);
    return new Promise((resolve) => {
      pendingMath.set(requestId, { element, resolve });
      parent.postMessage({
        type: 'droidex:render-math',
        instanceId,
        bridgeToken,
        requestId,
        latex,
        displayMode: options.displayMode === true || element.hasAttribute('data-display'),
      }, '*');
    });
  };
  const renderAllMath = (root = document) => Promise.all(
    [...root.querySelectorAll('[data-latex]')].map((element) =>
      renderMath(element, element.getAttribute('data-latex') ?? '')
    )
  );
  const postReady = () => {
    parent.postMessage({ type: 'droidex:app-ready', instanceId, bridgeToken }, '*');
  };
  const onHostMessage = (event) => {
    const data = event.data;
    if (
      event.source !== parent ||
      !data ||
      data.instanceId !== instanceId ||
      data.bridgeToken !== bridgeToken
    ) return;
    if (data.type === 'droidex:host-ready') {
      postReady();
      return;
    }
    if (data.type !== 'droidex:math-rendered' || typeof data.requestId !== 'string') return;
    const pending = pendingMath.get(data.requestId);
    if (!pending) return;
    pendingMath.delete(data.requestId);
    if (typeof data.html === 'string') {
      pending.element.innerHTML = data.html;
      pending.resolve(true);
    } else {
      pending.element.textContent = 'Unable to render this expression.';
      pending.resolve(false);
    }
    reportHeight();
  };
  addEventListener('message', onHostMessage);
  window.droidex = Object.freeze({ renderMath, renderAllMath });
  addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-droidex-app-root]') ??
      [...document.body.children].find((element) => !['SCRIPT', 'STYLE'].includes(element.tagName));
    root?.setAttribute('data-droidex-app-root', '');
    if (root && !root.querySelector('[data-droidex-app-canvas]')) {
      const visualRegions = [...root.children].filter((element) =>
        element.matches('svg, canvas') || element.querySelector('svg, canvas')
      );
      if (visualRegions.length === 1) {
        visualRegions[0].setAttribute('data-droidex-app-canvas', '');
      }
    }
    postReady();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(document.body);
    if (root && root !== document.body) observer.observe(root);
    void renderAllMath().finally(() => {
      initialRenderComplete = true;
      reportHeight();
    });
    addEventListener('pagehide', () => {
      disposed = true;
      if (heightTimer) clearTimeout(heightTimer);
      observer.disconnect();
      removeEventListener('message', onHostMessage);
      removeEventListener('error', onRuntimeError);
      removeEventListener('unhandledrejection', onUnhandledRejection);
      for (const pending of pendingMath.values()) pending.resolve(false);
      pendingMath.clear();
    }, { once: true });
  }, { once: true });
})();
</script>
</head>
<body>
${source}
<style data-droidex-app-host>
html, body { overflow: hidden !important; }
body { min-height: 0 !important; padding: 0 !important; }
[data-droidex-app-root] {
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  box-shadow: none !important;
}
[data-droidex-app-canvas] {
  margin-inline: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
</style>
</body>
</html>`;
}

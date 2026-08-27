function createNativeBrowserPage({
  appName,
  ensureEntry,
  restoreForAction,
  safeWebContents,
  scheduleIdleClose,
  setHiddenBounds,
  normalizeBrowserViewport,
  credentials,
  runWithWebContentsDebugger,
  findEntryForContents,
}) {
  function setDesignMode(browserSessionId, active) {
    const entry = ensureEntry(browserSessionId);
    const next = Boolean(active);
    if (entry.state.designMode === next) return;
    entry.state.designMode = next;
    if (!entry.state.designMode) entry.state.pencilMode = false;
    return applyDesignState(entry);
  }

  function setPencilMode(browserSessionId, active) {
    const entry = ensureEntry(browserSessionId);
    const next = entry.state.designMode && Boolean(active);
    if (entry.state.pencilMode === next) return;
    entry.state.pencilMode = next;
    return applyDesignState(entry);
  }

  function applyDesignState(entry) {
    if (!entry?.attached || !entry.visible) return undefined;
    const contents = safeWebContents(entry?.view);
    if (!contents) return undefined;
    return contents
      .executeJavaScript(
        `window.__DROIDMAXX_APPLY_DESIGN_STATE?.(${JSON.stringify(entry.state)});`,
        true,
      )
      .catch((err) => console.error(`failed to apply browser design state: ${err.message}`));
  }

  async function runAgentAction(request) {
    const entry = await restoreForAction(request.browserSessionId);
    try {
      const contents = safeWebContents(entry.view);
      if (!contents) throw new Error(`${appName} browser is not open.`);
      if (request.action === 'resize') {
        entry.viewport = normalizeBrowserViewport(request.viewport);
        // Attached bounds remain owned by the Browser pane layout.
        if (!entry.attached) setHiddenBounds(entry, entry.viewport);
        return { requestId: request.requestId, ok: true };
      }
      if (request.action === 'network') {
        const networkEvents = entry.networkEvents.slice();
        if (request.clearNetworkLog) entry.networkEvents.length = 0;
        return { requestId: request.requestId, ok: true, networkEvents };
      }
      if (request.action === 'console') {
        const consoleEvents = entry.consoleEvents.slice();
        if (request.clearConsoleLog) entry.consoleEvents.length = 0;
        return { requestId: request.requestId, ok: true, consoleEvents };
      }
      const navigation = observeAgentNavigation(contents);
      contents.setBackgroundThrottling(false);
      try {
        if (request.action === 'fillCredentials') {
          return withNativeBrowserHistory(
            contents,
            await credentials.fillForAgent(contents, request),
          );
        }
        const execution = executeAgentAction(contents, request).then(
          (result) => ({ type: 'result', result }),
          (error) => ({ type: 'error', error }),
        );
        const outcome = await Promise.race([
          execution,
          navigation.wait().then(() => ({ type: 'navigation' })),
        ]);
        if (outcome.type === 'navigation') {
          return await snapshotAfterNavigation(contents, request);
        }
        if (outcome.type === 'error') {
          if (!navigation.started() || !isNavigationExecutionError(outcome.error))
            throw outcome.error;
          await navigation.wait();
          return await snapshotAfterNavigation(contents, request);
        }
        return withNativeBrowserHistory(contents, outcome.result);
      } finally {
        navigation.dispose();
        restoreBackgroundThrottling(contents, entry);
      }
    } finally {
      scheduleIdleClose(entry);
    }
  }

  async function executeAgentAction(contents, request) {
    if (
      request.action === 'scroll' &&
      Number.isFinite(Number(request.x)) &&
      Number.isFinite(Number(request.y))
    ) {
      const x = Math.round(Number(request.x));
      const y = Math.round(Number(request.y));
      const pixels = Math.max(1, Math.round(Number(request.pixels) || 500));
      const horizontal = request.direction === 'left' || request.direction === 'right';
      contents.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: horizontal ? (request.direction === 'left' ? -pixels : pixels) : 0,
        deltaY: horizontal ? 0 : request.direction === 'up' ? -pixels : pixels,
        canScroll: true,
      });
      return contents.executeJavaScript(
        `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
          ...request,
          action: 'snapshot',
        })});`,
        true,
      );
    }
    if (request.action === 'click' || request.action === 'hover') {
      const point = await resolvePointer(contents, request);
      const x = point.x;
      const y = point.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('Browser pointer interaction requires finite viewport coordinates.');
      }
      contents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
      if (request.action === 'click') {
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }
      return contents.executeJavaScript(
        `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
          ...request,
          action: 'snapshot',
        })});`,
        true,
      );
    }
    return contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(request)});`,
      true,
    );
  }

  async function resolvePointer(contents, request) {
    if (typeof request.selector === 'string' && request.selector) {
      const point = await contents.executeJavaScript(
        `(() => {
        const target = document.querySelector(${JSON.stringify(request.selector)});
        if (!target) return null;
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        const box = target.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return null;
        return {
          x: Math.round(box.left + box.width / 2),
          y: Math.round(box.top + box.height / 2)
        };
      })()`,
        true,
      );
      if (!point) {
        throw new Error(
          'Browser target is no longer available. Refresh the snapshot and try again.',
        );
      }
      return point;
    }
    return {
      x: Math.round(Number(request.x)),
      y: Math.round(Number(request.y)),
    };
  }

  async function snapshotAfterNavigation(contents, request) {
    try {
      const result = await contents.executeJavaScript(
        `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
          requestId: request.requestId,
          action: 'snapshot',
        })});`,
        true,
      );
      return withNativeBrowserHistory(contents, result);
    } catch {
      return withNativeBrowserHistory(contents, { requestId: request.requestId, ok: true });
    }
  }

  function withNativeBrowserHistory(contents, result) {
    if (!result || typeof result !== 'object') return result;
    if (contents.isDestroyed()) return result;
    const history = contents.navigationHistory;
    if (!history || !result.snapshot) return result;
    return {
      ...result,
      snapshot: {
        ...result.snapshot,
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      },
    };
  }

  function observeAgentNavigation(contents, timeoutMs = 7_000) {
    let didStart = false;
    let settled = false;
    let timeout;
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveCompletion();
    };
    const onStart = (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame || didStart) return;
      didStart = true;
      timeout = setTimeout(finish, timeoutMs);
    };
    const onFinish = () => {
      if (didStart) finish();
    };
    const onFail = (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) finish();
    };
    const onDestroyed = () => finish();
    contents.on('did-start-navigation', onStart);
    contents.on('did-finish-load', onFinish);
    contents.on('did-fail-load', onFail);
    contents.on('destroyed', onDestroyed);
    return {
      started: () => didStart,
      wait: () => completion,
      dispose: () => {
        clearTimeout(timeout);
        contents.removeListener('did-start-navigation', onStart);
        contents.removeListener('did-finish-load', onFinish);
        contents.removeListener('did-fail-load', onFail);
        contents.removeListener('destroyed', onDestroyed);
      },
    };
  }

  function isNavigationExecutionError(err) {
    const message = String(err?.message || err).toLowerCase();
    return (
      message.includes('script execution was interrupted') ||
      message.includes('execution context was destroyed') ||
      message.includes('frame was disposed') ||
      message.includes('object has been destroyed')
    );
  }

  async function capture(browserSessionId, box, options = {}) {
    const entry = await restoreForAction(browserSessionId);
    const contents = safeWebContents(entry.view);
    if (!contents) throw new Error(`${appName} browser is not open.`);
    contents.setBackgroundThrottling(false);
    try {
      const fullPage = Boolean(options?.fullPage);
      const scale =
        typeof options?.deviceScaleFactor === 'number' && options.deviceScaleFactor > 0
          ? options.deviceScaleFactor
          : 2;
      // A box crop is always already on-screen (the user just selected/sketched
      // it). Capture the composited frame directly: capturePage never re-renders
      // the page off-screen the way CDP's captureBeyondViewport does, so the live
      // pane no longer flickers on every selection or sketch.
      if (box && !fullPage) {
        const rect = normalizeCaptureRect(entry, box);
        if (!rect) throw new Error('Requested capture region is empty or out of bounds.');
        const cropped = await contents.capturePage(rect).catch(() => undefined);
        if (cropped && !cropped.isEmpty()) return cropped.toPNG().toString('base64');
      }
      const data = await captureViaCdp(contents, { fullPage, scale, box }).catch((err) => {
        console.error(`cdp capture failed, falling back to viewport: ${err.message}`);
        return undefined;
      });
      if (data) return data;
      const rect = normalizeCaptureRect(entry, box);
      // A supplied box that normalizes away is an empty/out-of-bounds crop; fail
      // rather than silently returning the full viewport (unintended content).
      if (box && !rect) throw new Error('Requested capture region is empty or out of bounds.');
      const image = rect ? await contents.capturePage(rect) : await contents.capturePage();
      return image.isEmpty() ? undefined : image.toPNG().toString('base64');
    } finally {
      restoreBackgroundThrottling(contents, entry);
      scheduleIdleClose(entry);
    }
  }

  function restoreBackgroundThrottling(contents, entry) {
    if (entry.attached && entry.visible) return;
    try {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
    } catch {
      // Cleanup is best-effort when the browser closes during an action.
    }
  }

  async function captureViaCdp(contents, { fullPage, scale, box }) {
    return runWithWebContentsDebugger(contents, async (dbg) => {
      const params = { format: 'png', captureBeyondViewport: Boolean(fullPage) || Boolean(box) };
      const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport || metrics.visualViewport;
      const content = metrics.cssContentSize || metrics.contentSize;
      if (box) {
        // Selection boxes are viewport CSS coordinates; clips beyond the
        // viewport are in page coordinates, so offset by the current scroll.
        const x = (viewport.pageX || 0) + Math.max(0, box.x);
        const y = (viewport.pageY || 0) + Math.max(0, box.y);
        const width = Math.min(box.width, content.width - x);
        const height = Math.min(box.height, content.height - y);
        if (width <= 0 || height <= 0)
          throw new Error('Requested capture region is empty or out of bounds.');
        params.clip = { x, y, width, height, scale };
      } else if (fullPage) {
        if (content.width > 0 && content.height > 0) {
          params.clip = { x: 0, y: 0, width: content.width, height: content.height, scale };
        }
      } else if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
        params.clip = {
          x: 0,
          y: 0,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale,
        };
      }
      const result = await dbg.sendCommand('Page.captureScreenshot', params);
      return result?.data || undefined;
    });
  }

  const DESIGN_CAPTURE_PADDING = 32;

  // Capture the prompt's selection region with surrounding context while the
  // in-page annotations are still visible.
  async function captureDesignSelection(senderContents, selection) {
    const box = selection?.anchor?.box;
    if (!box || !(box.width > 0) || !(box.height > 0)) return undefined;
    const entry = findEntryForContents(senderContents);
    const contents = safeWebContents(entry?.view);
    if (!contents) return undefined;
    const padded = {
      x: Math.max(0, box.x - DESIGN_CAPTURE_PADDING),
      y: Math.max(0, box.y - DESIGN_CAPTURE_PADDING),
      width: box.width + DESIGN_CAPTURE_PADDING * 2,
      height: box.height + DESIGN_CAPTURE_PADDING * 2,
    };
    // Crop the on-screen composited frame (annotations are visible DOM overlays)
    // instead of a CDP captureBeyondViewport screenshot, which re-rasters the
    // page off-screen and flickers the pane on every send.
    const rect = normalizeCaptureRect(entry, padded);
    if (rect) {
      const image = await contents.capturePage(rect).catch(() => undefined);
      if (image && !image.isEmpty())
        return { base64: image.toPNG().toString('base64'), box: padded };
    }
    const base64 = await captureViaCdp(contents, { scale: 2, box: padded }).catch(() => undefined);
    return base64 ? { base64, box: padded } : undefined;
  }

  function normalizeCaptureRect(entry, box) {
    if (!box) return undefined;
    const bounds = entry.view?.getBounds?.() ?? { width: 0, height: 0 };
    const maxWidth = bounds.width || Number.MAX_SAFE_INTEGER;
    const maxHeight = bounds.height || Number.MAX_SAFE_INTEGER;
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const width = Math.min(Math.round(box.width), maxWidth - x);
    const height = Math.min(Math.round(box.height), maxHeight - y);
    if (width <= 0 || height <= 0) return undefined;
    return { x, y, width, height };
  }

  return {
    setDesignMode,
    setPencilMode,
    applyDesignState,
    runAgentAction,
    capture,
    captureDesignSelection,
  };
}

module.exports = { createNativeBrowserPage };

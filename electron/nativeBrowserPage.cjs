const MAX_SCREENSHOT_DIMENSION = 16_384;
const MAX_SCREENSHOT_PIXELS = 25_000_000;
const DESIGN_CAPTURE_PADDING = 32;

function createNativeBrowserPage({
  appName,
  ensureEntry,
  restoreForAction,
  safeWebContents,
  scheduleIdleClose,
  runWithWebContentsDebugger,
  findEntryForContents,
}) {
  function currentCapture(entry, view, contents, documentGeneration) {
    return (
      entry.view === view &&
      safeWebContents(view) === contents &&
      !contents.isDestroyed() &&
      entry.documentGeneration === documentGeneration
    );
  }

  function captureTarget(entry) {
    const view = entry?.view;
    const contents = safeWebContents(view);
    if (!view || !contents) throw new Error(`${appName} browser is not open.`);
    return { entry, view, contents, documentGeneration: entry.documentGeneration };
  }

  function assertCurrentCapture(target) {
    if (!currentCapture(target.entry, target.view, target.contents, target.documentGeneration)) {
      throw new Error('The page changed before the screenshot completed. No image was returned.');
    }
  }

  async function setSensitiveFieldMask(contents, active) {
    if (contents.isDestroyed())
      throw new Error('The browser page closed during screenshot capture.');
    const acknowledged = await contents.executeJavaScript(
      `window.__DROIDMAXX_MASK_SENSITIVE_FIELDS?.(${Boolean(active)});`,
      true,
    );
    if (acknowledged !== true) {
      throw new Error('Sensitive fields could not be masked. No screenshot was captured.');
    }
  }

  function beginCapture(entry) {
    if (entry.captureActivityCount !== 0) {
      throw new Error('A screenshot capture is already in progress.');
    }
    entry.captureActivityCount += 1;
  }

  function finishCapture(entry) {
    entry.captureActivityCount = Math.max(0, entry.captureActivityCount - 1);
    scheduleIdleClose(entry);
  }

  function normalizeCaptureRect(entry, box) {
    if (!box) return undefined;
    const bounds = entry.view?.getBounds?.() ?? { width: 0, height: 0 };
    const maxWidth = bounds.width || Number.MAX_SAFE_INTEGER;
    const maxHeight = bounds.height || Number.MAX_SAFE_INTEGER;
    const x = Math.max(0, Math.round(Number(box.x) || 0));
    const y = Math.max(0, Math.round(Number(box.y) || 0));
    const width = Math.min(Math.round(Number(box.width) || 0), maxWidth - x);
    const height = Math.min(Math.round(Number(box.height) || 0), maxHeight - y);
    if (width <= 0 || height <= 0) return undefined;
    return { x, y, width, height };
  }

  function validateScreenshotClip(clip) {
    if (!clip) return;
    const outputWidth = clip.width * clip.scale;
    const outputHeight = clip.height * clip.scale;
    const outputPixels = outputWidth * outputHeight;
    if (
      !Number.isFinite(outputWidth) ||
      !Number.isFinite(outputHeight) ||
      outputWidth <= 0 ||
      outputHeight <= 0 ||
      outputWidth > MAX_SCREENSHOT_DIMENSION ||
      outputHeight > MAX_SCREENSHOT_DIMENSION ||
      outputPixels > MAX_SCREENSHOT_PIXELS
    ) {
      const error = new Error(
        'The requested screenshot is too large. Use a viewport or region capture.',
      );
      error.code = 'ERR_BROWSER_SCREENSHOT_TOO_LARGE';
      throw error;
    }
  }

  async function captureViaCdp(contents, { fullPage, scale, box }) {
    return runWithWebContentsDebugger(contents, async (debuggerApi) => {
      const params = { format: 'png', captureBeyondViewport: Boolean(fullPage) || Boolean(box) };
      const metrics = await debuggerApi.sendCommand('Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
      const content = metrics.cssContentSize || metrics.contentSize || {};
      if (box) {
        const x = (Number(viewport.pageX) || 0) + Math.max(0, Number(box.x) || 0);
        const y = (Number(viewport.pageY) || 0) + Math.max(0, Number(box.y) || 0);
        const width = Math.min(Number(box.width) || 0, (Number(content.width) || 0) - x);
        const height = Math.min(Number(box.height) || 0, (Number(content.height) || 0) - y);
        if (width <= 0 || height <= 0) {
          throw new Error('Requested capture region is empty or out of bounds.');
        }
        params.clip = { x, y, width, height, scale };
      } else if (fullPage && content.width > 0 && content.height > 0) {
        params.clip = { x: 0, y: 0, width: content.width, height: content.height, scale };
      } else if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
        params.clip = {
          x: 0,
          y: 0,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale,
        };
      }
      validateScreenshotClip(params.clip);
      const result = await debuggerApi.sendCommand('Page.captureScreenshot', params);
      return result?.data || undefined;
    });
  }

  async function capture(browserSessionId, box, captureOptions = {}) {
    const entry = await restoreForAction(browserSessionId);
    const target = captureTarget(entry);
    beginCapture(entry);
    try {
      target.contents.setBackgroundThrottling(false);
      await setSensitiveFieldMask(target.contents, true);
      assertCurrentCapture(target);
      const fullPage = Boolean(captureOptions.fullPage);
      const scale =
        Number.isFinite(captureOptions.deviceScaleFactor) && captureOptions.deviceScaleFactor > 0
          ? captureOptions.deviceScaleFactor
          : 2;
      if (box && !fullPage) {
        const rect = normalizeCaptureRect(entry, box);
        if (!rect) throw new Error('Requested capture region is empty or out of bounds.');
        const cropped = await target.contents.capturePage(rect).catch(() => undefined);
        assertCurrentCapture(target);
        if (cropped && !cropped.isEmpty()) return cropped.toPNG().toString('base64');
      }
      let data;
      try {
        data = await captureViaCdp(target.contents, { fullPage, scale, box });
      } catch (error) {
        if (error?.code === 'ERR_BROWSER_SCREENSHOT_TOO_LARGE') throw error;
      }
      assertCurrentCapture(target);
      if (data) return data;
      const rect = normalizeCaptureRect(entry, box);
      if (box && !rect) throw new Error('Requested capture region is empty or out of bounds.');
      const image = rect
        ? await target.contents.capturePage(rect)
        : await target.contents.capturePage();
      assertCurrentCapture(target);
      return image.isEmpty() ? undefined : image.toPNG().toString('base64');
    } finally {
      if (currentCapture(entry, target.view, target.contents, target.documentGeneration)) {
        await setSensitiveFieldMask(target.contents, false).catch(() => undefined);
      }
      restoreBackgroundThrottling(target.contents, entry);
      finishCapture(entry);
    }
  }

  async function captureDesignSelection(senderContents, selection) {
    const box = selection?.anchor?.box;
    if (!box || !(box.width > 0) || !(box.height > 0)) return undefined;
    const entry = findEntryForContents(senderContents);
    if (!entry || safeWebContents(entry.view) !== senderContents) return undefined;
    const target = captureTarget(entry);
    beginCapture(entry);
    try {
      const padded = {
        x: Math.max(0, box.x - DESIGN_CAPTURE_PADDING),
        y: Math.max(0, box.y - DESIGN_CAPTURE_PADDING),
        width: box.width + DESIGN_CAPTURE_PADDING * 2,
        height: box.height + DESIGN_CAPTURE_PADDING * 2,
      };
      await setSensitiveFieldMask(target.contents, true);
      if (!currentCapture(entry, target.view, target.contents, target.documentGeneration)) {
        return undefined;
      }
      const rect = normalizeCaptureRect(entry, padded);
      if (rect) {
        const image = await target.contents.capturePage(rect).catch(() => undefined);
        if (!currentCapture(entry, target.view, target.contents, target.documentGeneration)) {
          return undefined;
        }
        if (image && !image.isEmpty()) {
          return { base64: image.toPNG().toString('base64'), box: padded };
        }
      }
      const base64 = await captureViaCdp(target.contents, { scale: 2, box: padded }).catch(
        () => undefined,
      );
      if (!currentCapture(entry, target.view, target.contents, target.documentGeneration)) {
        return undefined;
      }
      return base64 ? { base64, box: padded } : undefined;
    } finally {
      if (currentCapture(entry, target.view, target.contents, target.documentGeneration)) {
        await setSensitiveFieldMask(target.contents, false).catch(() => undefined);
      }
      finishCapture(entry);
    }
  }

  function restoreBackgroundThrottling(contents, entry) {
    if (entry.attached && entry.visible) return;
    try {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
    } catch {
      // The view may close while cleanup is running.
    }
  }

  function applyDesignState(entry) {
    if (!entry?.attached || !entry.visible) return undefined;
    const contents = safeWebContents(entry.view);
    if (!contents) return undefined;
    return contents
      .executeJavaScript(
        `window.__DROIDMAXX_APPLY_DESIGN_STATE?.(${JSON.stringify(entry.state)});`,
        true,
      )
      .catch(() => undefined);
  }

  function setDesignMode(browserSessionId, active) {
    const entry = ensureEntry(browserSessionId);
    const next = Boolean(active);
    if (entry.state.designMode === next) return undefined;
    entry.state.designMode = next;
    if (!next) entry.state.pencilMode = false;
    return applyDesignState(entry);
  }

  function setPencilMode(browserSessionId, active) {
    const entry = ensureEntry(browserSessionId);
    const next = entry.state.designMode && Boolean(active);
    if (entry.state.pencilMode === next) return undefined;
    entry.state.pencilMode = next;
    return applyDesignState(entry);
  }

  return {
    applyDesignState,
    capture,
    captureDesignSelection,
    setDesignMode,
    setPencilMode,
  };
}

module.exports = { createNativeBrowserPage };

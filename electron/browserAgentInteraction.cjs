const { runWithWebContentsDebugger } = require('./nativeBrowserEmulation.cjs');

async function executeBrowserAgentInteraction(contents, request, options) {
  if (request.action === 'scroll') {
    const hasTarget =
      request.selector || request.ref || request.x !== undefined || request.y !== undefined;
    const resolved = hasTarget ? await resolveBrowserPointer(contents, request) : undefined;
    assertCurrentBrowserAction(options);
    const x = resolved?.x ?? viewportCenter(options.viewportBounds, 'width');
    const y = resolved?.y ?? viewportCenter(options.viewportBounds, 'height');
    requirePointerInsideViewport({ x, y }, options.viewportBounds);
    await requireTrustedCursor(options, { x, y, pressed: false });
    assertCurrentBrowserAction(options);
    return contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(
        pageActionRequest(request, options, { x, y }),
      )});`,
      true,
    );
  }

  if (request.action === 'click' || request.action === 'hover') {
    const { x, y } = await resolveBrowserPointer(contents, request);
    assertCurrentBrowserAction(options);
    requirePointerInsideViewport({ x, y }, options.viewportBounds);
    await requireTrustedCursor(options, { x, y, pressed: request.action === 'click' });
    assertCurrentBrowserAction(options);
    if (request.action === 'hover') {
      const validation = await runWithWebContentsDebugger(contents, async (debuggerApi) => {
        assertCurrentBrowserAction(options);
        const result = await executePageAction(contents, request, options, { x, y });
        assertCurrentBrowserAction(options);
        if (result?.ok !== true) return result;
        await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          buttons: 0,
          clickCount: 0,
          pointerType: 'mouse',
        });
        return result;
      });
      assertCurrentBrowserAction(options);
      if (validation?.ok !== true) return validation;
      return executePageAction(contents, { ...request, action: 'snapshot' }, options);
    }
    return dispatchNativeClick(contents, request, options, { x, y });
  }

  if (request.action === 'keypress') {
    assertCurrentBrowserAction(options);
    const validation = await runWithWebContentsDebugger(contents, async (debuggerApi) => {
      assertCurrentBrowserAction(options);
      const result = await executePageAction(contents, request, options);
      assertCurrentBrowserAction(options);
      if (result?.ok !== true) return result;
      await dispatchNativeKey(debuggerApi, String(request.key || ''));
      return result;
    });
    assertCurrentBrowserAction(options);
    if (validation?.ok !== true) return validation;
    return executePageAction(contents, { ...request, action: 'snapshot' }, options);
  }

  assertCurrentBrowserAction(options);
  return contents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(pageActionRequest(request, options))});`,
    true,
  );
}

const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

// Keys are dispatched through Chromium so the page receives trusted events;
// printable keys (and Enter) also need the char event that drives text entry
// and implicit form submission.
async function dispatchNativeKey(debuggerApi, key) {
  const text = key.length === 1 ? key : key === 'Enter' ? '\r' : '';
  const code = KEY_CODES[key] ?? (text ? text.toUpperCase().charCodeAt(0) : 0);
  const base = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (text) {
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      ...base,
      type: 'char',
      text,
      unmodifiedText: text,
    });
  }
  await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

function dispatchNativeClick(contents, request, options, point) {
  return runWithWebContentsDebugger(contents, async (debuggerApi) => {
    assertCurrentBrowserAction(options);
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
      button: 'none',
      buttons: 0,
      clickCount: 0,
      pointerType: 'mouse',
    });
    assertCurrentBrowserAction(options);

    let buttonPressed = false;
    try {
      const prepared = await executePageAction(contents, request, options, {
        ...point,
        nativeInputPhase: 'prepare',
      });
      assertCurrentBrowserAction(options);
      if (prepared?.ok !== true) return prepared;
      buttonPressed = true;
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse',
      });
      assertCurrentBrowserAction(options);
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
      });
      buttonPressed = false;
      return await executePageAction(contents, request, options, {
        ...point,
        nativeInputPhase: 'complete',
      });
    } finally {
      if (buttonPressed && !contents.isDestroyed()) {
        await debuggerApi
          .sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...point,
            button: 'left',
            buttons: 0,
            clickCount: 0,
            pointerType: 'mouse',
          })
          .catch(() => undefined);
      }
      if (!contents.isDestroyed()) {
        await executePageAction(contents, request, options, {
          ...point,
          nativeInputPhase: 'cancel',
        }).catch(() => undefined);
      }
    }
  });
}

function executePageAction(contents, request, options, fields = {}) {
  return contents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(
      pageActionRequest(request, options, fields),
    )});`,
    true,
  );
}

function pageActionRequest(request, options, fields = {}) {
  return { ...request, ...fields, __droidexContext: options.pageContext };
}

function viewportCenter(bounds, dimension) {
  const value = Number(bounds?.[dimension]);
  return Math.min(value - 1, Math.round(value / 2));
}

function assertCurrentBrowserAction(options) {
  if (typeof options.isCurrent === 'function' && !options.isCurrent()) {
    throw new Error('The page changed before the browser action completed. No input was sent.');
  }
}

async function blockBrowserAgentSensitiveTyping(contents, request) {
  if (
    request.action !== 'type' &&
    !(request.action === 'keypress' && !['Enter', 'Tab', 'Escape'].includes(request.key))
  ) {
    return;
  }
  const sensitive = await contents.executeJavaScript(
    'window.__DROIDMAXX_SENSITIVE_FIELD?.();',
    true,
  );
  if (sensitive?.kind) {
    throw new Error(
      `DROIDEX will not send agent-authored text into a ${sensitive.kind} field. Use a saved login, OAuth/passkey, or enter it yourself.`,
    );
  }
}

async function resolveBrowserPointer(contents, request) {
  const point = await contents.executeJavaScript(
    `window.__DROIDMAXX_RESOLVE_POINTER?.(${JSON.stringify(request)});`,
    true,
  );
  if (!point) {
    throw new Error('Browser target is no longer available. Refresh the snapshot and try again.');
  }
  return { x: Number(point.x), y: Number(point.y) };
}

async function requireTrustedCursor(options, point) {
  if (typeof options.showCursor !== 'function' || (await options.showCursor(point)) !== true) {
    throw new Error('DROIDEX could not place the trusted agent cursor for this browser action.');
  }
}

function requirePointerInsideViewport(point, bounds) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= width ||
    point.y >= height
  ) {
    throw new Error('Browser pointer interaction is outside the live browser viewport.');
  }
}

module.exports = {
  blockBrowserAgentSensitiveTyping,
  executeBrowserAgentInteraction,
};

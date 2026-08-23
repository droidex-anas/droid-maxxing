async function executeBrowserAgentInteraction(contents, request, options) {
  if (
    request.action === 'scroll' &&
    Number.isFinite(Number(request.x)) &&
    Number.isFinite(Number(request.y))
  ) {
    const x = Math.round(Number(request.x));
    const y = Math.round(Number(request.y));
    requirePointerInsideViewport({ x, y }, options.viewportBounds);
    const pixels = Math.max(1, Math.round(Number(request.pixels) || 500));
    const horizontal = request.direction === 'left' || request.direction === 'right';
    await requireTrustedCursor(options, { x, y, pressed: false });
    contents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: horizontal ? (request.direction === 'left' ? -pixels : pixels) : 0,
      deltaY: horizontal ? 0 : request.direction === 'up' ? -pixels : pixels,
      canScroll: true,
    });
    return snapshotAfterInteraction(contents, request);
  }

  if (request.action === 'click' || request.action === 'hover') {
    const { x, y } = await resolveBrowserPointer(contents, request);
    requirePointerInsideViewport({ x, y }, options.viewportBounds);
    await requireTrustedCursor(options, { x, y, pressed: request.action === 'click' });
    contents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
    if (request.action === 'click') {
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
    return snapshotAfterInteraction(contents, request);
  }

  return contents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(request)});`,
    true,
  );
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
  if ((await options.showCursor?.(point)) === false) {
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

function snapshotAfterInteraction(contents, request) {
  return contents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
      ...request,
      action: 'snapshot',
    })});`,
    true,
  );
}

module.exports = {
  blockBrowserAgentSensitiveTyping,
  executeBrowserAgentInteraction,
};

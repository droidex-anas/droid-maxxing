const { requireFreshBrowserSnapshot } = require('./browserPageState.cjs');
const { setBrowserActionActive } = require('./nativeBrowserHost.cjs');

const CANCELED_ACTION_MESSAGE =
  'The page changed before the browser action completed. No input was sent.';

function createNativeBrowserAgentActions({
  appName,
  ensureView,
  getEntry,
  restoreForAction,
  openBrowser,
  reloadBrowser,
  closeBrowser,
  resizeBrowser,
  page,
  navigation,
  credentials,
  browserSettings,
  cursor,
  interaction,
  safeWebContents,
  scheduleIdleClose,
}) {
  // The renderer gave up on this request; the action stops at its next
  // checkpoint instead of touching the page after the caller has moved on.
  function cancel(browserSessionId, requestId) {
    const entry = getEntry(browserSessionId);
    if (!entry || entry.agentRequest?.requestId !== requestId) return false;
    entry.canceledRequestId = requestId;
    return true;
  }

  async function run(request) {
    if (request.action === 'close') {
      const existing = getEntry(request.browserSessionId);
      if (existing) bindAppSession(existing, request.appSessionId);
      closeBrowser(request.browserSessionId);
      return { requestId: request.requestId, ok: true };
    }

    const entry = ensureView(request.browserSessionId);
    bindAppSession(entry, request.appSessionId);
    if (entry.agentActionActive || entry.userNavigationActive) {
      throw new Error('A browser operation is already active for this session.');
    }
    const isUserRequest = request.source === 'user';
    const isUserNavigation = isUserRequest && request.action !== 'resize';
    const reservedView = entry.view;
    entry.agentRequest = isUserRequest ? null : request;
    entry.agentActionActive = !isUserNavigation;
    entry.userNavigationActive = isUserNavigation;
    let actionContents;
    try {
      if (!isUserRequest) {
        await browserSettings.authorizeAgentRequest(request);
        if (entry.canceledRequestId === request.requestId) throw new Error(CANCELED_ACTION_MESSAGE);
        if (
          getEntry(request.browserSessionId) !== entry ||
          entry.view !== reservedView ||
          !safeWebContents(reservedView)
        ) {
          throw new Error('The browser changed while agent authorization was pending.');
        }
      }

      if (request.action === 'open') {
        await openBrowser(request.browserSessionId, request.url, request.viewport);
        if (entry.canceledRequestId === request.requestId) throw new Error(CANCELED_ACTION_MESSAGE);
        if (entry.view !== reservedView || !safeWebContents(reservedView)) {
          throw new Error('The browser view changed while the page was opening.');
        }
        actionContents = requireContents(entry);
        setBrowserActionActive(entry, true);
        await navigation.consumePendingApproval(entry);
        return snapshotAfterNavigation(actionContents, request);
      }

      const restoredEntry = await restoreForAction(request.browserSessionId);
      actionContents = requireContents(restoredEntry);
      const actionView = restoredEntry.view;
      const actionDocumentGeneration = restoredEntry.documentGeneration;
      let abandoned = false;
      const isCurrentActionTarget = () =>
        !abandoned &&
        restoredEntry.canceledRequestId !== request.requestId &&
        restoredEntry.view === actionView &&
        safeWebContents(actionView) === actionContents &&
        !actionContents.isDestroyed() &&
        restoredEntry.documentGeneration === actionDocumentGeneration;
      const assertCurrentActionTarget = () => {
        if (!isCurrentActionTarget()) throw new Error(CANCELED_ACTION_MESSAGE);
      };
      setBrowserActionActive(restoredEntry, true);

      if (request.action === 'capture') {
        const image = await page.capture(request.browserSessionId, request.box, {
          fullPage: request.fullPage,
          deviceScaleFactor: request.deviceScaleFactor,
        });
        return { requestId: request.requestId, ok: true, image };
      }
      if (request.action === 'resize') {
        await resizeBrowser(restoredEntry, request.viewport);
        return { requestId: request.requestId, ok: true };
      }
      if (request.action === 'network') {
        const networkEvents = restoredEntry.networkEvents.slice();
        if (request.clearNetworkLog) restoredEntry.networkEvents.length = 0;
        return { requestId: request.requestId, ok: true, networkEvents };
      }
      if (request.action === 'console') {
        const consoleEvents = restoredEntry.consoleEvents.slice();
        if (request.clearConsoleLog) restoredEntry.consoleEvents.length = 0;
        return { requestId: request.requestId, ok: true, consoleEvents };
      }
      if (request.action === 'fillCredentials') {
        return withBrowserHistory(
          actionContents,
          await credentials.fillForAgent(restoredEntry, actionContents, request),
        );
      }
      if (request.action === 'snapshot') {
        return snapshotAfterNavigation(actionContents, request);
      }

      if (request.action === 'reload') {
        const observedNavigation = observeNavigation(actionContents);
        try {
          await Promise.all([reloadBrowser(request.browserSessionId), observedNavigation.wait()]);
          await navigation.consumePendingApproval(restoredEntry);
          return snapshotAfterNavigation(actionContents, request);
        } finally {
          observedNavigation.dispose();
        }
      }
      if (request.action === 'goBack' || request.action === 'goForward') {
        return await runHistoryAction(
          restoredEntry,
          actionContents,
          request,
          assertCurrentActionTarget,
        );
      }

      const pageContext = await actionContents.executeJavaScript(
        'window.__DROIDMAXX_AGENT_CONTEXT?.();',
        true,
      );
      assertCurrentActionTarget();
      requirePageContext(pageContext);
      await credentials.authorizeAuthentication(restoredEntry, actionContents, request);
      assertCurrentActionTarget();
      await interaction.blockBrowserAgentSensitiveTyping(actionContents, request);
      assertCurrentActionTarget();

      const observedNavigation = observeNavigation(actionContents);
      const execution = interaction
        .executeBrowserAgentInteraction(actionContents, request, {
          isCurrent: isCurrentActionTarget,
          pageContext,
          showCursor: ({ x, y, pressed }) => showAgentCursor(restoredEntry, { x, y, pressed }),
          viewportBounds: actionView.getBounds(),
        })
        .then(
          (result) => ({ type: 'result', result }),
          (error) => ({ type: 'error', error }),
        );
      try {
        const outcome = await Promise.race([
          execution,
          observedNavigation.wait().then(() => ({ type: 'navigation' })),
        ]);
        if (await navigation.consumePendingApproval(restoredEntry)) {
          return snapshotAfterNavigation(actionContents, request);
        }
        if (outcome.type === 'navigation') {
          return snapshotAfterNavigation(actionContents, request);
        }
        if (outcome.type === 'error') {
          if (!observedNavigation.started() || !isNavigationExecutionError(outcome.error)) {
            throw outcome.error;
          }
          await observedNavigation.wait();
          return snapshotAfterNavigation(actionContents, request);
        }
        if (observedNavigation.started()) {
          await observedNavigation.wait();
          return snapshotAfterNavigation(actionContents, request);
        }
        return withBrowserHistory(actionContents, outcome.result);
      } finally {
        abandoned = true;
        await execution;
        observedNavigation.dispose();
      }
    } catch (error) {
      credentials.invalidate(entry);
      throw error;
    } finally {
      if (actionContents) setBrowserActionActive(entry, false);
      if (entry.agentActionActive) navigation.finishAgentAction(entry);
      entry.agentRequest = null;
      entry.canceledRequestId = null;
      entry.agentActionActive = false;
      entry.userNavigationActive = false;
      if (getEntry(request.browserSessionId) === entry) scheduleIdleClose(entry);
    }
  }

  function requireContents(entry) {
    const contents = safeWebContents(entry.view);
    if (!contents) throw new Error(`${appName} browser is not open.`);
    return contents;
  }

  function bindAppSession(entry, appSessionId) {
    if (entry.appSessionId && entry.appSessionId !== appSessionId) {
      throw new Error('Browser session belongs to a different DROIDEX chat.');
    }
    entry.appSessionId = appSessionId;
  }

  function requirePageContext(pageContext) {
    if (
      !pageContext ||
      typeof pageContext.documentId !== 'string' ||
      typeof pageContext.snapshotId !== 'string' ||
      typeof pageContext.urlHash !== 'string' ||
      !pageContext.documentId ||
      !pageContext.snapshotId ||
      !pageContext.urlHash
    ) {
      throw new Error('The browser page has no current action snapshot. Refresh and try again.');
    }
  }

  async function runHistoryAction(entry, contents, request, assertCurrentActionTarget) {
    const history = contents.navigationHistory;
    const offset = request.action === 'goBack' ? -1 : 1;
    if (!history?.canGoToOffset(offset)) return snapshotAfterNavigation(contents, request);
    const target = history.getEntryAtIndex(history.getActiveIndex() + offset);
    if (target?.url && isCrossOriginNavigation(contents.getURL(), target.url)) {
      await navigation.authorizeHistoryTransition(entry, entry.view, target.url, request.autonomy);
    }
    assertCurrentActionTarget();
    const observedNavigation = observeNavigation(contents);
    try {
      history.goToOffset(offset);
      await observedNavigation.wait();
      await navigation.consumePendingApproval(entry);
      return snapshotAfterNavigation(contents, request);
    } finally {
      observedNavigation.dispose();
    }
  }

  async function snapshotAfterNavigation(contents, request) {
    const result = await contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
        requestId: request.requestId,
        action: 'snapshot',
      })});`,
      true,
    );
    return withBrowserHistory(contents, requireFreshBrowserSnapshot(result, request.requestId));
  }

  function withBrowserHistory(contents, result) {
    if (!result || typeof result !== 'object' || contents.isDestroyed()) return result;
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

  function showAgentCursor(entry, point) {
    // The overlay exists only while the renderer reports an active run; an
    // action outside one still records its point so the input stays trusted.
    if (!entry.attached || !entry.visible || !entry.agentCursorActive) {
      return cursor.park({
        browserSessionId: entry.browserSessionId,
        bounds: entry.view.getBounds(),
        ...point,
      });
    }
    return cursor.show({ browserSessionId: entry.browserSessionId, ...point });
  }

  function observeNavigation(contents, timeoutMs = 7_000) {
    let didStart = false;
    let settled = false;
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveCompletion();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error('Browser navigation timed out before the page finished loading.');
      error.code = 'ERR_BROWSER_NAVIGATION_TIMEOUT';
      rejectCompletion(error);
    }, timeoutMs);
    timeout.unref?.();
    const onStart = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) didStart = true;
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

  function isNavigationExecutionError(error) {
    const message = String(error?.message || error).toLowerCase();
    return (
      message.includes('script execution was interrupted') ||
      message.includes('execution context was destroyed') ||
      message.includes('frame was disposed') ||
      message.includes('object has been destroyed')
    );
  }

  return { cancel, run };
}

function isCrossOriginNavigation(currentUrl, nextUrl) {
  try {
    return new URL(currentUrl).origin !== new URL(nextUrl).origin;
  } catch {
    return true;
  }
}

module.exports = { createNativeBrowserAgentActions };

const {
  agentNavigationAutonomy,
  consumeTrustedUserNavigation,
  createTrustedUserNavigation,
} = require('./browserNavigationProvenance.cjs');
const { parseSafeHttpUrl } = require('./nativeBrowserUrls.cjs');

const TRANSITION_KINDS = new Set(['navigate', 'popup', 'redirect']);

function createNativeBrowserNavigation({
  browserSettings,
  loadUrl,
  safeWebContents,
  now = Date.now,
}) {
  function recordTrustedUserNavigation(entry, view, activationId, destinationUrl) {
    entry.trustedUserNavigation = null;
    if (entry.agentActionActive) return false;
    if (typeof activationId !== 'string' || !activationId || activationId.length > 100) {
      return false;
    }
    try {
      entry.trustedUserNavigation = createTrustedUserNavigation({
        activationId,
        browserSessionId: entry.browserSessionId,
        destinationUrl,
        view,
        navigationGeneration: entry.navigationGeneration,
        documentGeneration: entry.documentGeneration,
        issuedAt: now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  function clearTrustedUserNavigation(entry) {
    entry.trustedUserNavigation = null;
  }

  function authorizeTransition(entry, view, kind, destinationUrl) {
    if (!TRANSITION_KINDS.has(kind)) {
      throw new Error('Unknown browser navigation transition.');
    }
    const contents = safeWebContents(view);
    if (!contents || entry.view !== view) return false;
    if (!isCrossOriginNavigation(contents.getURL(), destinationUrl)) return true;
    if (consumeApprovedHistoryTransition(entry, view, kind, destinationUrl)) {
      return true;
    }
    const trustedUserTransition =
      entry.userNavigationActive ||
      (kind !== 'redirect' && consumeTrustedPhysicalNavigation(entry, view, destinationUrl));
    if (trustedUserTransition) return true;
    beginAgentNavigationApproval(entry, view, destinationUrl);
    return false;
  }

  function consumeTrustedPhysicalNavigation(entry, view, destinationUrl) {
    const capability = entry.trustedUserNavigation;
    entry.trustedUserNavigation = null;
    if (entry.agentActionActive) return false;
    return consumeTrustedUserNavigation(capability, {
      browserSessionId: entry.browserSessionId,
      destinationUrl,
      view,
      navigationGeneration: entry.navigationGeneration,
      documentGeneration: entry.documentGeneration,
      now: now(),
    });
  }

  async function authorizeHistoryTransition(entry, view, destinationUrl, autonomy) {
    const exactDestinationUrl = parseSafeHttpUrl(destinationUrl)?.href;
    if (!exactDestinationUrl) {
      throw new Error('Agent browser navigation requires an exact HTTP(S) target.');
    }
    entry.approvedHistoryTransition = null;
    const navigationGeneration = entry.navigationGeneration;
    const documentGeneration = entry.documentGeneration;
    await browserSettings.authorizeAgentOrigin(exactDestinationUrl, autonomy);
    assertCurrentNavigation(entry, view, navigationGeneration);
    if (entry.documentGeneration !== documentGeneration) {
      throw new Error('Browser navigation was canceled because the browser page changed.');
    }
    entry.approvedHistoryTransition = {
      view,
      navigationGeneration,
      documentGeneration,
      destinationUrl: exactDestinationUrl,
    };
  }

  function consumeApprovedHistoryTransition(entry, view, kind, destinationUrl) {
    const approval = entry.approvedHistoryTransition;
    entry.approvedHistoryTransition = null;
    return Boolean(
      approval &&
      kind === 'navigate' &&
      approval.view === view &&
      approval.navigationGeneration === entry.navigationGeneration &&
      approval.documentGeneration === entry.documentGeneration &&
      approval.destinationUrl === parseSafeHttpUrl(destinationUrl)?.href,
    );
  }

  function beginAgentNavigationApproval(entry, view, requestedUrl) {
    if (entry.pendingAgentNavigation?.requestedUrl === requestedUrl) {
      return entry.pendingAgentNavigation.promise;
    }
    if (entry.pendingAgentNavigation) invalidate(entry);
    const generation = entry.navigationGeneration;
    let approval;
    try {
      approval = browserSettings.authorizeAgentOrigin(
        requestedUrl,
        agentNavigationAutonomy(entry.agentRequest),
      );
    } catch (error) {
      approval = Promise.reject(error);
    }
    const promise = Promise.resolve(approval).then(async () => {
      assertCurrentNavigation(entry, view, generation);
      const result = await loadUrl(entry, requestedUrl, { force: true });
      if (!result?.ok) {
        throw new Error(result?.error || 'The approved browser navigation failed to load.');
      }
      assertCurrentNavigation(entry, view, generation);
    });
    const pending = { generation, requestedUrl, promise };
    entry.pendingAgentNavigation = pending;
    void promise
      .finally(() => {
        if (!entry.agentRequest && entry.pendingAgentNavigation === pending) {
          entry.pendingAgentNavigation = null;
        }
      })
      .catch(() => undefined);
    return promise;
  }

  function assertCurrentNavigation(entry, view, generation) {
    if (entry.navigationGeneration !== generation || entry.view !== view) {
      throw new Error('Browser navigation was canceled because the browser session changed.');
    }
  }

  async function consumePendingApproval(entry) {
    const pending = entry.pendingAgentNavigation;
    if (!pending) return false;
    try {
      await pending.promise;
      return true;
    } finally {
      if (entry.pendingAgentNavigation === pending) entry.pendingAgentNavigation = null;
    }
  }

  function finishAgentAction(entry) {
    entry.approvedHistoryTransition = null;
    if (entry.pendingAgentNavigation) invalidate(entry);
  }

  function invalidate(entry) {
    entry.navigationGeneration += 1;
    entry.pendingAgentNavigation = null;
    entry.trustedUserNavigation = null;
    entry.approvedHistoryTransition = null;
  }

  return {
    authorizeTransition,
    authorizeHistoryTransition,
    clearTrustedUserNavigation,
    consumePendingApproval,
    finishAgentAction,
    invalidate,
    recordTrustedUserNavigation,
  };
}

function isCrossOriginNavigation(currentUrl, nextUrl) {
  try {
    return new URL(currentUrl).origin !== new URL(nextUrl).origin;
  } catch {
    return true;
  }
}

module.exports = { createNativeBrowserNavigation };

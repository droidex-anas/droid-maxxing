const {
  agentNavigationAutonomy,
  consumeTrustedUserNavigation,
  createTrustedUserNavigation,
} = require('./browserNavigationProvenance.cjs');

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

  function expireTrustedUserNavigation(entry, activationId) {
    if (entry.trustedUserNavigation?.activationId !== activationId) return false;
    entry.trustedUserNavigation = null;
    return true;
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
    return consumeTrustedUserNavigation(capability, {
      browserSessionId: entry.browserSessionId,
      destinationUrl,
      view,
      navigationGeneration: entry.navigationGeneration,
      documentGeneration: entry.documentGeneration,
      now: now(),
    });
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

  function invalidate(entry) {
    entry.navigationGeneration += 1;
    entry.pendingAgentNavigation = null;
    entry.trustedUserNavigation = null;
  }

  return {
    authorizeTransition,
    clearTrustedUserNavigation,
    consumePendingApproval,
    expireTrustedUserNavigation,
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

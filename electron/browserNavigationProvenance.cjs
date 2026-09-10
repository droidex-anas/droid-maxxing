const TRUSTED_USER_NAVIGATION_TTL_MS = 1_000;

function createTrustedUserNavigation({
  activationId,
  browserSessionId,
  destinationUrl,
  view,
  navigationGeneration,
  documentGeneration,
  issuedAt = Date.now(),
}) {
  if (typeof activationId !== 'string' || !activationId) {
    throw new Error('Trusted browser navigation requires an activation id.');
  }
  return {
    activationId,
    browserSessionId,
    destinationUrl: new URL(destinationUrl).href,
    view,
    navigationGeneration,
    documentGeneration,
    issuedAt,
    consumed: false,
  };
}

function consumeTrustedUserNavigation(capability, transition) {
  if (!capability || capability.consumed) return false;
  capability.consumed = true;
  let destinationUrl;
  try {
    destinationUrl = new URL(transition.destinationUrl).href;
  } catch {
    return false;
  }
  return (
    transition.now >= capability.issuedAt &&
    transition.now - capability.issuedAt <= TRUSTED_USER_NAVIGATION_TTL_MS &&
    capability.browserSessionId === transition.browserSessionId &&
    capability.destinationUrl === destinationUrl &&
    capability.view === transition.view &&
    capability.navigationGeneration === transition.navigationGeneration &&
    capability.documentGeneration === transition.documentGeneration
  );
}

function agentNavigationAutonomy(agentRequest) {
  return agentRequest?.autonomy ?? 'low';
}

module.exports = {
  agentNavigationAutonomy,
  consumeTrustedUserNavigation,
  createTrustedUserNavigation,
};

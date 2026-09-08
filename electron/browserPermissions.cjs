const { randomUUID } = require('node:crypto');
const { MAX_BROWSER_URL_LENGTH, parseSafeHttpUrl } = require('./nativeBrowserUrls.cjs');

const MEDIA_TYPES = new Set(['audio', 'video']);
const SITE_DECISIONS = new Set(['allow', 'ask', 'deny']);
const PROMPT_DECISIONS = new Set(['allow_once', 'allow_always', 'deny_once', 'deny_always']);

function createBrowserPermissionController(options) {
  if (typeof options?.isNativeBrowserContents !== 'function') {
    throw new Error('Browser permission controller requires a WebContents ownership check.');
  }
  if (typeof options?.getSiteDecision !== 'function') {
    throw new Error('Browser permission controller requires an exact-site policy reader.');
  }
  if (typeof options?.persistSiteDecision !== 'function') {
    throw new Error('Browser permission controller requires an exact-site policy writer.');
  }
  if (typeof options?.requestPermission !== 'function') {
    throw new Error('Browser permission controller requires an app permission prompt.');
  }

  const nextPromptId = options.nextPromptId ?? randomUUID;
  const states = new Map();

  function stateFor(contents) {
    let state = states.get(contents);
    if (!state) {
      state = { generation: 0, grants: new Set(), pendingPrompt: null };
      states.set(contents, state);
    }
    return state;
  }

  function isOwnedContents(contents) {
    if (!contents || typeof contents !== 'object') return false;
    try {
      if (contents.isDestroyed?.()) return false;
      return options.isNativeBrowserContents(contents) === true;
    } catch {
      return false;
    }
  }

  function canAccess(contents, permission, requestingOrigin, details) {
    if (permission !== 'media' || !isOwnedContents(contents)) return false;
    const origin = permissionOrigin(details, requestingOrigin);
    const mediaType = normalizeCheckMediaType(details?.mediaType);
    if (!origin || !mediaType || !isCurrentOrigin(contents, origin)) return false;
    const decision = siteDecision(origin, mediaType);
    if (decision === 'deny') return false;
    if (decision === 'allow') return true;
    return stateFor(contents).grants.has(grantKey(origin, mediaType));
  }

  function handleRequest(contents, permission, callback, details) {
    const done = once(callback);
    if (permission !== 'media' || !isOwnedContents(contents)) {
      done(false);
      return;
    }

    const origin = permissionOrigin(details);
    const mediaTypes = normalizeRequestedMediaTypes(details?.mediaTypes);
    if (!origin || mediaTypes.length === 0 || !isCurrentOrigin(contents, origin)) {
      done(false);
      return;
    }

    const state = stateFor(contents);
    const decisions = mediaTypes.map((mediaType) => ({
      mediaType,
      decision: siteDecision(origin, mediaType),
    }));
    if (decisions.some(({ decision }) => decision === 'deny')) {
      done(false);
      return;
    }

    const unresolvedMediaTypes = decisions
      .filter(
        ({ mediaType, decision }) =>
          decision === 'ask' && !state.grants.has(grantKey(origin, mediaType)),
      )
      .map(({ mediaType }) => mediaType);
    if (unresolvedMediaTypes.length === 0) {
      done(true);
      return;
    }
    if (state.pendingPrompt) {
      done(false);
      return;
    }

    const promptId = nextPromptId();
    if (typeof promptId !== 'string' || promptId.length < 1) {
      done(false);
      return;
    }
    const expectedGeneration = state.generation;
    const abortController = new AbortController();
    state.pendingPrompt = { promptId, abortController, origin, mediaTypes };

    void Promise.resolve()
      .then(() => {
        if (!isCurrentPrompt(contents, state, promptId, expectedGeneration, origin)) {
          return undefined;
        }
        return options.requestPermission({
          promptId,
          origin,
          mediaTypes: unresolvedMediaTypes,
          signal: abortController.signal,
        });
      })
      .then(async (response) => {
        if (
          !isCurrentPrompt(contents, state, promptId, expectedGeneration, origin) ||
          response?.promptId !== promptId ||
          !PROMPT_DECISIONS.has(response?.decision)
        ) {
          return false;
        }
        if (unresolvedMediaTypes.some((mediaType) => siteDecision(origin, mediaType) === 'deny')) {
          return false;
        }

        if (response.decision === 'allow_once') {
          addGrants(state.grants, origin, unresolvedMediaTypes);
          return true;
        }
        if (response.decision === 'deny_once') return false;

        const persistentDecision = response.decision === 'allow_always' ? 'allow' : 'deny';
        await persistDecision(origin, unresolvedMediaTypes, persistentDecision);
        if (!isCurrentPrompt(contents, state, promptId, expectedGeneration, origin)) {
          return false;
        }
        removeGrantKeys(state.grants, origin, unresolvedMediaTypes);
        return persistentDecision === 'allow';
      })
      .catch(() => false)
      .then((allowed) => {
        if (state.pendingPrompt?.promptId === promptId) state.pendingPrompt = null;
        done(allowed);
      });
  }

  async function setSiteDecision(value, mediaTypes, decision) {
    const origin = requestingHttpOrigin(value);
    const normalizedTypes = normalizeRequestedMediaTypes(mediaTypes);
    if (!origin) throw new Error('Browser site permission requires an exact HTTP origin.');
    if (normalizedTypes.length === 0) {
      throw new Error('Browser site permission requires camera or microphone access.');
    }
    if (!SITE_DECISIONS.has(decision)) {
      throw new Error('Browser site permission must be allow, ask, or deny.');
    }
    await persistDecision(origin, normalizedTypes, decision);
    invalidateOrigin(origin, normalizedTypes);
  }

  function revokeForNavigation(contents) {
    const state = contents && states.get(contents);
    if (!state) return;
    state.generation += 1;
    state.grants.clear();
    cancelPendingPrompt(state);
  }

  function revokeForContents(contents) {
    const state = contents && states.get(contents);
    if (!state) return;
    state.generation += 1;
    state.grants.clear();
    cancelPendingPrompt(state);
    states.delete(contents);
  }

  function revokeTemporaryOrigin(contents, value) {
    const origin = requestingHttpOrigin(value);
    const state = contents && states.get(contents);
    if (!origin || !state) return false;
    state.generation += 1;
    cancelPendingPrompt(state);
    return removeGrantKeys(state.grants, origin, [...MEDIA_TYPES]) > 0;
  }

  function consume(contents, value, mediaTypes) {
    const origin = requestingHttpOrigin(value);
    const state = contents && states.get(contents);
    const normalizedTypes = normalizeRequestedMediaTypes(mediaTypes);
    if (!origin || !state || normalizedTypes.length === 0) return false;
    const keys = normalizedTypes.map((mediaType) => grantKey(origin, mediaType));
    if (keys.some((key) => !state.grants.has(key))) return false;
    for (const key of keys) state.grants.delete(key);
    return true;
  }

  function siteDecision(origin, mediaType) {
    try {
      const decision = options.getSiteDecision(origin, mediaType);
      if (decision === undefined) return 'ask';
      return SITE_DECISIONS.has(decision) ? decision : 'deny';
    } catch {
      return 'deny';
    }
  }

  async function persistDecision(origin, mediaTypes, decision) {
    await options.persistSiteDecision({ origin, mediaTypes: [...mediaTypes], decision });
  }

  function invalidateOrigin(origin, mediaTypes) {
    for (const state of states.values()) {
      const prompt = state.pendingPrompt;
      if (
        prompt?.origin === origin &&
        prompt.mediaTypes.some((mediaType) => mediaTypes.includes(mediaType))
      ) {
        state.generation += 1;
        cancelPendingPrompt(state);
      }
      removeGrantKeys(state.grants, origin, mediaTypes);
    }
  }

  function isCurrentPrompt(contents, state, promptId, generation, origin) {
    return (
      isOwnedContents(contents) &&
      isCurrentOrigin(contents, origin) &&
      state.pendingPrompt?.promptId === promptId &&
      state.generation === generation
    );
  }

  return {
    canAccess,
    consume,
    handleRequest,
    revokeForContents,
    revokeForNavigation,
    revokeTemporaryOrigin,
    setSiteDecision,
  };
}

function cancelPendingPrompt(state) {
  state.pendingPrompt?.abortController.abort();
  state.pendingPrompt = null;
}

function isCurrentOrigin(contents, expectedOrigin) {
  try {
    return requestingHttpOrigin(contents.getURL?.()) === expectedOrigin;
  } catch {
    return false;
  }
}

function permissionOrigin(details, fallback) {
  return requestingHttpOrigin(details?.securityOrigin || details?.requestingUrl || fallback);
}

function normalizeCheckMediaType(value) {
  return MEDIA_TYPES.has(value) ? value : undefined;
}

function normalizeRequestedMediaTypes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((mediaType) => MEDIA_TYPES.has(mediaType)))].sort();
}

function grantKey(origin, mediaType) {
  return `${origin}\0${mediaType}`;
}

function addGrants(grants, origin, mediaTypes) {
  for (const mediaType of mediaTypes) grants.add(grantKey(origin, mediaType));
}

function removeGrantKeys(grants, origin, mediaTypes) {
  let removed = 0;
  for (const mediaType of mediaTypes) {
    if (grants.delete(grantKey(origin, mediaType))) removed += 1;
  }
  return removed;
}

function requestingHttpOrigin(value) {
  return parseSafeHttpUrl(value, { maxLength: MAX_BROWSER_URL_LENGTH })?.origin;
}

function once(callback) {
  if (typeof callback !== 'function') return () => {};
  let called = false;
  return (value) => {
    if (called) return;
    called = true;
    callback(value);
  };
}

module.exports = { createBrowserPermissionController, requestingHttpOrigin };

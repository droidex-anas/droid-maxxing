function chooseBrowserReload({ currentUrl, failedRestoreUrl, loadingUrl, targetUrl, homePage }) {
  if (
    isBrowserPageUrl(loadingUrl) &&
    (!isBrowserPageUrl(currentUrl) || !browserPageUrlsMatch(loadingUrl, currentUrl))
  ) {
    return { kind: 'load', url: loadingUrl };
  }
  if (isBrowserPageUrl(currentUrl)) return { kind: 'reload', url: currentUrl };
  for (const url of [failedRestoreUrl, loadingUrl, targetUrl, homePage]) {
    if (isBrowserPageUrl(url)) return { kind: 'load', url };
  }
  throw new Error('DROIDEX Browser has no valid page to reload.');
}

function browserPageUrlsMatch(left, right) {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function chooseBrowserRestore({ currentUrl, targetUrl, homePage }) {
  if (isBrowserPageUrl(currentUrl)) return null;
  if (isBrowserPageUrl(targetUrl)) return targetUrl;
  if (isBrowserPageUrl(homePage)) return homePage;
  return null;
}

function browserTargetBeforeViewClose({ currentUrl, loadingUrl, targetUrl }) {
  for (const url of [loadingUrl, currentUrl, targetUrl]) {
    if (isBrowserPageUrl(url)) return url;
  }
  return null;
}

function isBrowserPageUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function userVisibleBrowserUrl(value) {
  if (value === 'about:blank') return value;
  if (!isBrowserPageUrl(value)) {
    throw new Error('DROIDEX Browser loaded an invalid page URL.');
  }
  return String(value);
}

function requireFreshBrowserSnapshot(result, requestId) {
  if (!result || typeof result !== 'object') {
    throw new Error('DROIDEX Browser did not return a result.');
  }
  if (result.requestId !== requestId) {
    throw new Error('DROIDEX Browser returned a mismatched snapshot result.');
  }
  if (!result.ok) {
    throw new Error(result.error || 'DROIDEX Browser snapshot failed.');
  }
  if (!result.snapshot) {
    throw new Error('DROIDEX Browser did not return a fresh page snapshot.');
  }
  if (!isBrowserPageUrl(result.snapshot.url)) {
    throw new Error('DROIDEX Browser returned an invalid page snapshot.');
  }
  return result;
}

function isExpectedSupersededLoad({ error, requestedUrl, targetUrl, currentUrl }) {
  const aborted =
    String(error?.code || '').includes('ERR_ABORTED') ||
    String(error?.message || '').includes('ERR_ABORTED');
  return (
    aborted &&
    isBrowserPageUrl(currentUrl) &&
    isBrowserPageUrl(targetUrl) &&
    !browserPageUrlsMatch(requestedUrl, targetUrl) &&
    browserPageUrlsMatch(currentUrl, targetUrl)
  );
}

module.exports = {
  browserTargetBeforeViewClose,
  chooseBrowserReload,
  chooseBrowserRestore,
  isExpectedSupersededLoad,
  isBrowserPageUrl,
  requireFreshBrowserSnapshot,
  userVisibleBrowserUrl,
};
